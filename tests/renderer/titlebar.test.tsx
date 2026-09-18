// @vitest-environment jsdom
import { render, screen, fireEvent, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TitleBar, { WindowResizeHandles } from '../../src/renderer/components/TitleBar';

/**
 * 无边框窗口的自绘标题栏与缩放热区（QYP3-042）：按钮走新的 WINDOW.* 通道，
 * 最大化图标跟随主进程推送，热区只报鼠标位移增量（bounds 归主进程算）。
 */

const minimizeWindow = vi.fn();
const toggleMaximizeWindow = vi.fn();
const closeWindow = vi.fn();
const resizeWindowBy = vi.fn();
let pushMaximize: ((maximized: boolean) => void) | null = null;

vi.stubGlobal('electronAPI', {
  isWindowMaximized: vi.fn(async () => ({ ok: true, data: false })),
  onWindowMaximizeChange: vi.fn((cb: (v: boolean) => void) => {
    pushMaximize = cb;
    return () => {
      pushMaximize = null;
    };
  }),
  minimizeWindow,
  toggleMaximizeWindow,
  closeWindow,
  resizeWindowBy,
});

beforeEach(() => {
  vi.clearAllMocks();
  pushMaximize = null;
});

describe('TitleBar (QYP3-042)', () => {
  it('renders window controls that call the new window channels', () => {
    render(<TitleBar />);
    fireEvent.click(screen.getByRole('button', { name: '最小化' }));
    expect(minimizeWindow).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(closeWindow).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '最大化' }));
    expect(toggleMaximizeWindow).toHaveBeenCalled();
  });

  it('swaps the maximize icon when the main process pushes a maximized state', () => {
    render(<TitleBar />);
    expect(screen.getByRole('button', { name: '最大化' })).toBeTruthy();
    act(() => pushMaximize?.(true));
    expect(screen.getByRole('button', { name: '还原' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '最大化' })).toBeNull();
    act(() => pushMaximize?.(false));
    expect(screen.getByRole('button', { name: '最大化' })).toBeTruthy();
  });

  it('shows a restore-from-compact button instead of maximize in compact mode', () => {
    render(<TitleBar compact />);
    expect(screen.queryByRole('button', { name: '最大化' })).toBeNull();
    expect(screen.getByRole('button', { name: '还原窗口' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '最小化' })).toBeTruthy();
  });
});

describe('WindowResizeHandles (QYP3-042)', () => {
  // jsdom 的 MouseEvent 不支持 movementX/Y 初始化，手工挂上去模拟真实浏览器
  const pointerMove = (movementX: number, movementY: number): void => {
    const event = new Event('pointermove');
    Object.assign(event, { movementX, movementY });
    window.dispatchEvent(event);
  };

  it('reports pointer deltas per edge while dragging', () => {
    render(<WindowResizeHandles />);
    fireEvent.pointerDown(screen.getByTestId('resize-e'));
    pointerMove(8, 0);
    expect(resizeWindowBy).toHaveBeenCalledWith('e', 8, 0);

    fireEvent.pointerDown(screen.getByTestId('resize-sw'));
    pointerMove(-3, 5);
    expect(resizeWindowBy.mock.calls.at(-1)).toEqual(['sw', -3, 5]);
  });

  it('stops reporting after pointerup', () => {
    render(<WindowResizeHandles />);
    fireEvent.pointerDown(screen.getByTestId('resize-s'));
    pointerMove(0, 4);
    const calls = resizeWindowBy.mock.calls.length;
    window.dispatchEvent(new MouseEvent('pointerup'));
    pointerMove(0, 4);
    expect(resizeWindowBy.mock.calls.length).toBe(calls);
  });

  it('covers all eight edges', () => {
    render(<WindowResizeHandles />);
    for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      expect(screen.getByTestId(`resize-${edge}`)).toBeTruthy();
    }
  });
});
