// @vitest-environment jsdom
import { act } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeskLyrics from '../../../src/renderer/pages/DeskLyrics';

type Listener = (payload: {
  type: 'state' | 'style';
  state?: { title: string; content: string | null; position: number; isPlaying: boolean };
  style?: { fontSize: number; locked: boolean };
}) => void;

let emit: Listener | null = null;

vi.stubGlobal('electronAPI', {
  onDeskLyricsEvent: (cb: Listener) => {
    emit = cb;
    return () => {
      emit = null;
    };
  },
});

const LRC = ['[00:01.00]第一行', '[00:05.00]第二行', '[00:09.00]第三行'].join('\n');

beforeEach(() => {
  emit = null;
});

describe('DeskLyrics window (QYP3-022)', () => {
  it('renders the current line and the next line', () => {
    const { container } = render(<DeskLyrics />);
    act(() => {
      emit?.({ type: 'state', state: { title: '晴天', content: LRC, position: 6, isPlaying: true } });
    });
    const text = container.textContent ?? '';
    expect(text).toContain('第二行');
    expect(text).toContain('第三行');
    expect(text).not.toContain('第一行');
  });

  it('renders nothing while paused or without lyrics', () => {
    const { container } = render(<DeskLyrics />);
    act(() => {
      emit?.({ type: 'state', state: { title: '晴天', content: LRC, position: 6, isPlaying: false } });
    });
    expect(container.textContent).toBe('');
    act(() => {
      emit?.({ type: 'state', state: { title: '晴天', content: null, position: 0, isPlaying: true } });
    });
    expect(container.textContent).toBe('');
  });

  it('applies the pushed font size', () => {
    const { container } = render(<DeskLyrics />);
    act(() => {
      emit?.({ type: 'style', style: { fontSize: 40, locked: true } });
      emit?.({ type: 'state', state: { title: '晴天', content: LRC, position: 1, isPlaying: true } });
    });
    const line = container.querySelector('p') as HTMLParagraphElement;
    expect(line.style.fontSize).toBe('40px');
  });
});
