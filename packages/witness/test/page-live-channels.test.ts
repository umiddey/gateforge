/**
 * Declared live channels (`pages.liveChannels`): the pure rules that
 * decide which exchanges a page keeps open on purpose. Pure and offline.
 */
import { describe, expect, it } from 'vitest';
import { LiveChannelTracker, appHostsOfOrigins } from '../src/witness/page-live-channels.js';

const appHosts = appHostsOfOrigins(['http://127.0.0.1:47013']);

function tracker(prefixes: readonly string[]): LiveChannelTracker {
  return new LiveChannelTracker(prefixes, appHosts);
}

describe('live channel rules', () => {
  it('declares a same-origin request under a declared prefix live', () => {
    const live = tracker(['/live/']);
    expect(live.isLiveByUrl(new URL('http://127.0.0.1:47013/live/poll?EIO=4&transport=polling'))).toBe(true);
    expect(live.isLiveByUrl(new URL('http://127.0.0.1:47013/orders/42'))).toBe(false);
  });

  it('never guesses: an undeclared long-poll path stays app data', () => {
    const live = tracker(['/live/']);
    expect(live.isLiveByUrl(new URL('http://127.0.0.1:47013/socket.io/?EIO=4&transport=polling'))).toBe(false);
  });

  it('keeps a declared prefix on a foreign host out (same-origin only)', () => {
    const live = tracker(['/live/']);
    expect(live.isLiveByUrl(new URL('http://other.example.com/live/poll'))).toBe(false);
  });

  it('treats an app-host WebSocket upgrade as a live channel by protocol', () => {
    const live = tracker([]);
    expect(live.isLiveByUrl(new URL('ws://127.0.0.1:47013/socket'))).toBe(true);
    expect(live.isLiveByUrl(new URL('wss://127.0.0.1:47013/socket'))).toBe(true);
    expect(live.isLiveByUrl(new URL('ws://other.example.com/socket'))).toBe(false);
    expect(live.isLiveByUrl(new URL('http://127.0.0.1:47013/socket'))).toBe(false);
  });

  it('reads a server-sent-events content type as live', () => {
    expect(LiveChannelTracker.isEventStream('text/event-stream')).toBe(true);
    expect(LiveChannelTracker.isEventStream('text/event-stream; charset=utf-8')).toBe(true);
    expect(LiveChannelTracker.isEventStream('  Text/Event-Stream ')).toBe(true);
    expect(LiveChannelTracker.isEventStream('text/html')).toBe(false);
    expect(LiveChannelTracker.isEventStream(null)).toBe(false);
  });

  it('lists distinct sorted paths and counts them', () => {
    const live = tracker(['/live/']);
    live.note(new URL('http://127.0.0.1:47013/live/poll?transport=polling'));
    live.note(new URL('http://127.0.0.1:47013/live/poll?transport=polling&sid=1'));
    live.note(new URL('http://127.0.0.1:47013/live/stream'));
    expect(live.snapshot()).toEqual({ count: 2, paths: ['/live/poll', '/live/stream'] });
  });

  it('snapshot starts empty', () => {
    expect(tracker(['/live/']).snapshot()).toEqual({ count: 0, paths: [] });
  });
});
