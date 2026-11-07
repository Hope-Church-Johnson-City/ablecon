// Shared data shapes.

export interface Cue {
  name: string;
  time: number; // beats
}

export interface Section {
  name: string;
  start: number; // beats
  end: number; // beats
}

export interface Song {
  id: string; // stable key used by the setlist file
  name: string; // title, without a "(G)" key suffix
  key: { pitch: number; minor: boolean } | null; // original key written in the locator name
  start: number; // beats
  end: number; // beats
  stopAtEnd: boolean; // ends at a STOP/-- marker; otherwise playback runs on into whatever follows
  sections: Section[];
}

export interface SetlistEntry {
  songId: string;
  name: string; // last known song name, for display when the song goes missing
  tempo: number | null; // BPM, null = leave Live's tempo alone
  semitones: number | null; // -12..12, null = leave pitch alone
  seenTempo?: number | null; // tempo Live reported near the song's start (tempo automation), for timing
}

export type EndOfSong = 'stop' | 'next' | 'continue';

export interface SetlistSettings {
  endOfSong: EndOfSong;
  noKeyTag: string; // comma-separated words; tracks whose names contain one are never transposed
  sectionsTrack: string; // name of the track whose clips mark sections
}

export interface SetlistFile {
  version: 1;
  entries: SetlistEntry[];
  settings: SetlistSettings;
}

export interface Position {
  beats: number;
  playing: boolean;
  tempo: number;
  loop: { enabled: boolean; start: number; length: number };
}

// What the Remote Script's "tracks" method reports.
export interface ClipInfo {
  index: number;
  name: string;
  start: number;
  end: number;
  isAudio: boolean;
  warping: boolean | null;
  pitch: number | null;
}

export interface ParamInfo {
  index: number;
  name: string;
  value: number;
  min: number;
  max: number;
}

export interface PitchDeviceInfo {
  index: number;
  name: string;
  params: ParamInfo[];
}

export interface TrackInfo {
  index: number;
  name: string;
  parents: string[];
  isMidi: boolean;
  isAudio: boolean;
  isGroup: boolean;
  clips: ClipInfo[];
  pitchDevices: PitchDeviceInfo[];
}

export type KeyOp =
  | { kind: 'clip'; track: number; trackName: string; clip: number; start: number; pitch: number }
  | { kind: 'param'; track: number; trackName: string; device: number; param: number; value: number };

// What the Remote Script's "mixer" method reports for each track.
export interface MixerTrack {
  index: number;
  name: string;
  parents: string[]; // enclosing group names, innermost first
  isGroup: boolean;
  muted: boolean;
  mutedViaSolo: boolean; // silent because another track is soloed
}
