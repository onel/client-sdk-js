import { EventEmitter } from 'events';
import { Track } from '../track/Track';
import { TrackPublication } from '../track/TrackPublication';
import {
  AudioTrackPublication,
  DataTrackPublication,
  VideoTrackPublication,
} from '../track/types';

export type AudioTrackMap = { [key: string]: AudioTrackPublication };
export type VideoTrackMap = { [key: string]: VideoTrackPublication };
export type DataTrackMap = { [key: string]: DataTrackPublication };

export class Participant extends EventEmitter {
  // map of track id => AudioTrack
  audioTracks: AudioTrackMap = {};
  videoTracks: VideoTrackMap = {};
  dataTracks: DataTrackMap = {};
  tracks: { [key: string]: TrackPublication } = {};
  sid: string;
  // client assigned identity
  name: string;

  constructor(sid: string, name: string) {
    super();
    this.sid = sid;
    this.name = name;
  }

  protected addTrackPublication(publication: TrackPublication) {
    this.tracks[publication.trackSid] = publication;
    switch (publication.kind) {
      case Track.Kind.Audio:
        this.audioTracks[publication.trackSid] = <AudioTrackPublication>(
          publication
        );
        break;
      case Track.Kind.Video:
        this.videoTracks[publication.trackSid] = <VideoTrackPublication>(
          publication
        );
        break;
      case Track.Kind.Data:
        this.dataTracks[publication.trackSid] = <DataTrackPublication>(
          publication
        );
        break;
    }
  }

  getTracks(): TrackPublication[] {
    return Object.values(this.tracks);
  }
}
