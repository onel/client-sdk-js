import { EventEmitter } from 'events';
import { SignalClient, SignalOptions } from '../api/SignalClient';
import log from '../logger';
import { DataPacket, DataPacket_Kind, TrackInfo } from '../proto/livekit_models';
import {
  AddTrackRequest, JoinResponse,
  LeaveRequest,
  SignalTarget,
  TrackPublishedResponse,
} from '../proto/livekit_rtc';
import { ConnectionError, TrackInvalidError, UnexpectedConnectionState } from './errors';
import { EngineEvent } from './events';
import PCTransport from './PCTransport';
import { isFireFox, sleep } from './utils';

const lossyDataChannel = '_lossy';
const reliableDataChannel = '_reliable';
const maxReconnectRetries = 10;
const minReconnectWait = 1 * 1000;
const maxReconnectDuration = 60 * 1000;
export const maxICEConnectTimeout = 15 * 1000;

/** @internal */
export default class RTCEngine extends EventEmitter {
  publisher?: PCTransport;

  subscriber?: PCTransport;

  client: SignalClient;

  rtcConfig: RTCConfiguration = {};

  private lossyDC?: RTCDataChannel;

  // @ts-ignore noUnusedLocals
  private lossyDCSub?: RTCDataChannel;

  private reliableDC?: RTCDataChannel;

  // @ts-ignore noUnusedLocals
  private reliableDCSub?: RTCDataChannel;

  private subscriberPrimary: boolean = false;

  private primaryPC?: RTCPeerConnection;

  private pcConnected: boolean = false;

  private isClosed: boolean = true;

  private pendingTrackResolvers: { [key: string]: (info: TrackInfo) => void } = {};

  // true if publisher connection has already been established.
  // this is helpful to know if we need to restart ICE on the publisher connection
  private hasPublished: boolean = false;

  // keep join info around for reconnect
  private url?: string;

  private token?: string;

  private signalOpts?: SignalOptions;

  private reconnectAttempts: number = 0;

  private reconnectStart: number = 0;

  private fullReconnect: boolean = false;

  private connectedServerAddr?: string;

  constructor() {
    super();
    this.client = new SignalClient();
  }

  async join(url: string, token: string, opts?: SignalOptions): Promise<JoinResponse> {
    this.url = url;
    this.token = token;
    this.signalOpts = opts;

    const joinResponse = await this.client.join(url, token, opts);
    this.isClosed = false;

    this.subscriberPrimary = joinResponse.subscriberPrimary;
    if (!this.publisher) {
      this.configure(joinResponse);
    }

    // create offer
    if (!this.subscriberPrimary) {
      this.negotiate();
    }

    return joinResponse;
  }

  close() {
    this.isClosed = true;

    this.removeAllListeners();
    if (this.publisher && this.publisher.pc.signalingState !== 'closed') {
      this.publisher.pc.getSenders().forEach((sender) => {
        try {
          this.publisher?.pc.removeTrack(sender);
        } catch (e) {
          log.warn('could not removeTrack', e);
        }
      });
      this.publisher.close();
      this.publisher = undefined;
    }
    if (this.subscriber) {
      this.subscriber.close();
      this.subscriber = undefined;
    }
    this.client.close();
  }

  addTrack(req: AddTrackRequest): Promise<TrackInfo> {
    if (this.pendingTrackResolvers[req.cid]) {
      throw new TrackInvalidError(
        'a track with the same ID has already been published',
      );
    }
    return new Promise<TrackInfo>((resolve) => {
      this.pendingTrackResolvers[req.cid] = resolve;
      this.client.sendAddTrack(req);
    });
  }

  updateMuteStatus(trackSid: string, muted: boolean) {
    this.client.sendMuteTrack(trackSid, muted);
  }

  get dataSubscriberReadyState(): string | undefined {
    return this.reliableDCSub?.readyState;
  }

  get connectedServerAddress(): string | undefined {
    return this.connectedServerAddr;
  }

  private configure(joinResponse: JoinResponse) {
    // already configured
    if (this.publisher || this.subscriber) {
      return;
    }

    // update ICE servers before creating PeerConnection
    if (joinResponse.iceServers && !this.rtcConfig.iceServers) {
      const rtcIceServers: RTCIceServer[] = [];
      joinResponse.iceServers.forEach((iceServer) => {
        const rtcIceServer: RTCIceServer = {
          urls: iceServer.urls,
        };
        if (iceServer.username) rtcIceServer.username = iceServer.username;
        if (iceServer.credential) { rtcIceServer.credential = iceServer.credential; }
        rtcIceServers.push(rtcIceServer);
      });
      this.rtcConfig.iceServers = rtcIceServers;
    }

    this.publisher = new PCTransport(this.rtcConfig);
    this.subscriber = new PCTransport(this.rtcConfig);

    this.publisher.pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      log.trace('adding ICE candidate for peer', ev.candidate);
      this.client.sendIceCandidate(ev.candidate, SignalTarget.PUBLISHER);
    };

    this.subscriber.pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      this.client.sendIceCandidate(ev.candidate, SignalTarget.SUBSCRIBER);
    };

    this.publisher.onOffer = (offer) => {
      this.client.sendOffer(offer);
    };

    let primaryPC = this.publisher.pc;
    if (joinResponse.subscriberPrimary) {
      primaryPC = this.subscriber.pc;
      // in subscriber primary mode, server side opens sub data channels.
      this.subscriber.pc.ondatachannel = this.handleDataChannel;
    }
    this.primaryPC = primaryPC;
    primaryPC.onconnectionstatechange = async () => {
      if (primaryPC.connectionState === 'connected') {
        log.trace('pc connected');
        try {
          this.connectedServerAddr = await getConnectedAddress(primaryPC);
        } catch (e) {
          log.warn('could not get connected server address', e);
        }
        if (!this.pcConnected) {
          this.pcConnected = true;
          this.emit(EngineEvent.Connected);
        }
      } else if (primaryPC.connectionState === 'failed') {
        // on Safari, PeerConnection will switch to 'disconnected' during renegotiation
        log.trace('pc disconnected');
        if (this.pcConnected) {
          this.pcConnected = false;

          this.handleDisconnect('peerconnection');
        }
      }
    };

    this.subscriber.pc.ontrack = (ev: RTCTrackEvent) => {
      this.emit(EngineEvent.MediaTrackAdded, ev.track, ev.streams[0], ev.receiver);
    };

    // data channels
    this.lossyDC = this.publisher.pc.createDataChannel(lossyDataChannel, {
      // will drop older packets that arrive
      ordered: true,
      maxRetransmits: 0,
    });
    this.reliableDC = this.publisher.pc.createDataChannel(reliableDataChannel, {
      ordered: true,
    });

    // also handle messages over the pub channel, for backwards compatibility
    this.lossyDC.onmessage = this.handleDataMessage;
    this.reliableDC.onmessage = this.handleDataMessage;

    // handle datachannel errors
    this.lossyDC.onerror = this.handleDataError;
    this.reliableDC.onerror = this.handleDataError;

    // configure signaling client
    this.client.onAnswer = async (sd) => {
      if (!this.publisher) {
        return;
      }
      log.debug(
        'received server answer',
        sd.type,
        this.publisher.pc.signalingState,
      );
      await this.publisher.setRemoteDescription(sd);
    };

    // add candidate on trickle
    this.client.onTrickle = (candidate, target) => {
      if (!this.publisher || !this.subscriber) {
        return;
      }
      log.trace('got ICE candidate from peer', candidate, target);
      if (target === SignalTarget.PUBLISHER) {
        this.publisher.addIceCandidate(candidate);
      } else {
        this.subscriber.addIceCandidate(candidate);
      }
    };

    // when server creates an offer for the client
    this.client.onOffer = async (sd) => {
      if (!this.subscriber) {
        return;
      }
      log.debug(
        'received server offer',
        sd.type,
        this.subscriber.pc.signalingState,
      );
      await this.subscriber.setRemoteDescription(sd);

      // answer the offer
      const answer = await this.subscriber.pc.createAnswer();
      await this.subscriber.pc.setLocalDescription(answer);
      this.client.sendAnswer(answer);
    };

    this.client.onLocalTrackPublished = (res: TrackPublishedResponse) => {
      log.debug('received trackPublishedResponse', res);
      const resolve = this.pendingTrackResolvers[res.cid];
      if (!resolve) {
        log.error('missing track resolver for ', res.cid);
        return;
      }
      delete this.pendingTrackResolvers[res.cid];
      resolve(res.track!);
    };

    this.client.onTokenRefresh = (token: string) => {
      this.token = token;
    };

    this.client.onClose = () => {
      this.handleDisconnect('signal');
    };

    this.client.onLeave = (leave?: LeaveRequest) => {
      if (leave?.canReconnect) {
        this.fullReconnect = true;
        this.primaryPC = undefined;
      } else {
        this.emit(EngineEvent.Disconnected);
        this.close();
      }
    };
  }

  private handleDataChannel = async ({ channel }: RTCDataChannelEvent) => {
    if (!channel) {
      return;
    }
    if (channel.label === reliableDataChannel) {
      this.reliableDCSub = channel;
    } else if (channel.label === lossyDataChannel) {
      this.lossyDCSub = channel;
    } else {
      return;
    }
    channel.onmessage = this.handleDataMessage;
  };

  private handleDataMessage = async (message: MessageEvent) => {
    // decode
    let buffer: ArrayBuffer | undefined;
    if (message.data instanceof ArrayBuffer) {
      buffer = message.data;
    } else if (message.data instanceof Blob) {
      buffer = await message.data.arrayBuffer();
    } else {
      log.error('unsupported data type', message.data);
      return;
    }
    const dp = DataPacket.decode(new Uint8Array(buffer));
    if (dp.speaker) {
      // dispatch speaker updates
      this.emit(EngineEvent.ActiveSpeakersUpdate, dp.speaker.speakers);
    } else if (dp.user) {
      this.emit(EngineEvent.DataPacketReceived, dp.user, dp.kind);
    }
  };

  private handleDataError = (event: Event) => {
    const channel = event.currentTarget as RTCDataChannel;
    const channelKind = channel.maxRetransmits === 0 ? 'lossy' : 'reliable';

    if (event instanceof ErrorEvent) {
      const { error } = event.error;
      log.error(`DataChannel error on ${channelKind}: ${event.message}`, error);
    } else {
      log.error(`Unknown DataChannel Error on ${channelKind}`, event);
    }
  };

  // websocket reconnect behavior. if websocket is interrupted, and the PeerConnection
  // continues to work, we can reconnect to websocket to continue the session
  // after a number of retries, we'll close and give up permanently
  private handleDisconnect = (connection: string) => {
    if (this.isClosed) {
      return;
    }
    log.debug(`${connection} disconnected`);
    if (this.reconnectAttempts === 0) {
      // only reset start time on the first try
      this.reconnectStart = Date.now();
    }

    const delay = (this.reconnectAttempts * this.reconnectAttempts) * 300;
    setTimeout(async () => {
      if (this.isClosed) {
        return;
      }
      if (isFireFox()) {
        // FF does not support DTLS restart.
        this.fullReconnect = true;
      }

      try {
        if (this.fullReconnect) {
          await this.restartConnection();
        } else {
          await this.resumeConnection();
        }
        this.reconnectAttempts = 0;
        this.fullReconnect = false;
      } catch (e) {
        this.reconnectAttempts += 1;
        let recoverable = true;
        if (e instanceof UnexpectedConnectionState) {
          log.debug('received unrecoverable error', e.message);
          // unrecoverable
          recoverable = false;
        } else if (!(e instanceof SignalReconnectError)) {
          // cannot resume
          this.fullReconnect = true;
        }

        const duration = Date.now() - this.reconnectStart;
        if (this.reconnectAttempts >= maxReconnectRetries || duration > maxReconnectDuration) {
          recoverable = false;
        }

        if (recoverable) {
          this.handleDisconnect('reconnect');
        } else {
          log.info(
            `could not recover connection after ${maxReconnectRetries} attempts, ${duration}ms. giving up`,
          );
          this.emit(EngineEvent.Disconnected);
          this.close();
        }
      }
    }, delay);
  };

  private async restartConnection() {
    if (!this.url || !this.token) {
      // permanent failure, don't attempt reconnection
      throw new UnexpectedConnectionState('could not reconnect, url or token not saved');
    }

    log.info('reconnecting, attempt', this.reconnectAttempts);
    if (this.reconnectAttempts === 0) {
      this.emit(EngineEvent.Restarting);
    }

    this.primaryPC = undefined;
    this.publisher?.close();
    this.publisher = undefined;
    this.subscriber?.close();
    this.subscriber = undefined;

    let joinResponse: JoinResponse;
    try {
      joinResponse = await this.join(this.url, this.token, this.signalOpts);
    } catch (e) {
      throw new SignalReconnectError();
    }

    await this.waitForPCConnected();

    // reconnect success
    this.emit(EngineEvent.Restarted, joinResponse);
  }

  private async resumeConnection(): Promise<void> {
    if (!this.url || !this.token) {
      // permanent failure, don't attempt reconnection
      throw new UnexpectedConnectionState('could not reconnect, url or token not saved');
    }
    // trigger publisher reconnect
    if (!this.publisher || !this.subscriber) {
      throw new UnexpectedConnectionState('publisher and subscriber connections unset');
    }
    log.info('resuming signal connection, attempt', this.reconnectAttempts);
    if (this.reconnectAttempts === 0) {
      this.emit(EngineEvent.Resuming);
    }

    try {
      await this.client.reconnect(this.url, this.token);
    } catch (e) {
      throw new SignalReconnectError();
    }
    this.emit(EngineEvent.SignalResumed);

    this.subscriber.restartingIce = true;

    // only restart publisher if it's needed
    if (this.hasPublished) {
      await this.publisher.createAndSendOffer({ iceRestart: true });
    }

    await this.waitForPCConnected();

    // resume success
    this.emit(EngineEvent.Resumed);
  }

  async waitForPCConnected() {
    const startTime = (new Date()).getTime();
    let now = startTime;
    this.pcConnected = false;

    while (now - startTime < maxICEConnectTimeout) {
      // if there is no connectionstatechange callback fired
      // check connectionstate after minReconnectWait
      if (this.primaryPC === undefined) {
        // we can abort early, connection is hosed
        break;
      } else if (now - startTime > minReconnectWait && this.primaryPC?.connectionState === 'connected') {
        this.pcConnected = true;
      }
      if (this.pcConnected) {
        return;
      }
      await sleep(100);
      now = (new Date()).getTime();
    }

    // have not reconnected, throw
    throw new ConnectionError('could not establish PC connection');
  }

  /* @internal */
  async sendDataPacket(packet: DataPacket, kind: DataPacket_Kind) {
    const msg = DataPacket.encode(packet).finish();

    // make sure we do have a data connection
    await this.ensurePublisherConnected(kind);

    if (kind === DataPacket_Kind.LOSSY && this.lossyDC) {
      this.lossyDC.send(msg);
    } else if (kind === DataPacket_Kind.RELIABLE && this.reliableDC) {
      this.reliableDC.send(msg);
    }
  }

  private async ensurePublisherConnected(kind: DataPacket_Kind) {
    if (!this.subscriberPrimary) {
      return;
    }

    if (!this.publisher) {
      throw new ConnectionError('publisher connection not set');
    }

    if (!this.publisher.isICEConnected && this.publisher.pc.iceConnectionState !== 'checking') {
      // start negotiation
      this.negotiate();
    }

    const targetChannel = this.dataChannelForKind(kind);
    if (targetChannel?.readyState === 'open') {
      return;
    }

    // wait until publisher ICE connected
    const endTime = (new Date()).getTime() + maxICEConnectTimeout;
    while ((new Date()).getTime() < endTime) {
      if (this.publisher.isICEConnected && this.dataChannelForKind(kind)?.readyState === 'open') {
        return;
      }
      await sleep(50);
    }

    throw new ConnectionError(`could not establish publisher connection, state ${this.publisher?.pc.iceConnectionState}`);
  }

  /** @internal */
  negotiate() {
    if (!this.publisher) {
      return;
    }

    this.hasPublished = true;

    this.publisher.negotiate();
  }

  private dataChannelForKind(kind: DataPacket_Kind): RTCDataChannel | undefined {
    if (kind === DataPacket_Kind.LOSSY) {
      return this.lossyDC;
    } if (kind === DataPacket_Kind.RELIABLE) {
      return this.reliableDC;
    }
  }
}

async function getConnectedAddress(pc: RTCPeerConnection): Promise<string | undefined> {
  let selectedCandidatePairId = '';
  const candidatePairs = new Map<string, RTCIceCandidatePairStats>();
  // id -> candidate ip
  const candidates = new Map<string, string>();
  const stats: RTCStatsReport = await pc.getStats();
  stats.forEach((v) => {
    switch (v.type) {
      case 'transport':
        selectedCandidatePairId = v.selectedCandidatePairId;
        break;
      case 'candidate-pair':
        if (selectedCandidatePairId === '' && v.selected) {
          selectedCandidatePairId = v.id;
        }
        candidatePairs.set(v.id, v);
        break;
      case 'remote-candidate':
        candidates.set(v.id, `${v.address}:${v.port}`);
        break;
      default:
    }
  });

  if (selectedCandidatePairId === '') {
    return undefined;
  }
  const selectedID = candidatePairs.get(selectedCandidatePairId)?.remoteCandidateId;
  if (selectedID === undefined) {
    return undefined;
  }
  return candidates.get(selectedID);
}

class SignalReconnectError extends Error {
}
