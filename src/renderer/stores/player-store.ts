import { create } from 'zustand';

export interface PlayerState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;
  isFullscreen: boolean;
  isVisible: boolean;
}

interface PlayerStore extends PlayerState {
  setPlaying: (playing: boolean) => void;
  setCurrentTime: (time: number) => void;
  setDuration: (duration: number) => void;
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
  setFullscreen: (fullscreen: boolean) => void;
  setVisible: (visible: boolean) => void;
  updateState: (partial: Partial<PlayerState>) => void;
}

export const usePlayerStore = create<PlayerStore>((set) => ({
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  volume: 100,
  isMuted: false,
  isFullscreen: false,
  isVisible: false,

  setPlaying: (playing) => set({ isPlaying: playing }),
  setCurrentTime: (time) => set({ currentTime: time }),
  setDuration: (duration) => set({ duration }),
  setVolume: (volume) => set({ volume }),
  setMuted: (muted) => set({ isMuted: muted }),
  setFullscreen: (fullscreen) => set({ isFullscreen: fullscreen }),
  setVisible: (visible) => set({ isVisible: visible }),
  updateState: (partial) => set(partial),
}));
