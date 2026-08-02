// Link padding. padding-spec §2.
//
// A client's connection to its guard is long-lived and mostly idle. A middlebox keeping
// netflow records treats each idle gap as the connection ending and a new one starting, and
// that record — when your connection to a guard began and ended — is exactly the timing an
// end-to-end correlation attack wants. It is collected by default on a great many networks,
// by equipment nobody thinks of as an adversary.
//
// Padding removes the gaps: whenever the link has been quiet for a randomly chosen interval,
// one side sends a cell carrying nothing, and the flow record stays open.
//
// ## What this does not defend against
//
// Anyone watching the link itself. A padding cell is the same 514 bytes as every other cell,
// and an observer on the wire counts them all identically — so this changes the *shape* of a
// flow record and hides nothing from someone reading the flow. Nor is it the circuit-level
// padding that defends against website fingerprinting; that is WTF-PAD, negotiated per
// circuit with RELAY_DROP cells, and it is not implemented here.
//
// Getting that distinction wrong is how a defence becomes a false sense of one.

import { wacBind } from "../../../harness/wacBind.ts";
import type { Link } from "./link.ts";

const mod = await wacBind("packages/tor/test/wac/link_probe.wac");
const encodePaddingNegotiate = mod.encodePaddingNegotiate as (
  command: number, lowMs: number, highMs: number,
) => Uint8Array;
const encodePadding = mod.encodePadding as () => Uint8Array;
export const PADDING_START = (mod.paddingCommandStart as () => number)();
export const PADDING_STOP = (mod.paddingCommandStop as () => number)();

/**
 * The consensus defaults for `nf_ito_low` and `nf_ito_high`, in milliseconds.
 *
 * A floor, not a setting: tor takes `MAX(consensus, negotiated)` for both bounds, so
 * negotiating can only make padding *less* frequent than this. A client that could ask for
 * one-millisecond padding could ask a relay to flood it, so the asymmetry is deliberate —
 * but it does mean `requestPadding` with a tighter range is a no-op, and the default here
 * exists to make that visible rather than to be tuned.
 */
export const NF_ITO_LOW_MS = 1500;
export const NF_ITO_HIGH_MS = 9500;

/**
 * Ask the peer to pad towards us when the link is idle.
 *
 * Note that a relay only pads a channel it considers in use — one carrying full circuits or
 * user traffic. Negotiating on a bare link and waiting produces nothing, which looks exactly
 * like the negotiation having failed; it has not.
 */
export async function requestPadding(
  link: Link, lowMs = NF_ITO_LOW_MS, highMs = NF_ITO_HIGH_MS,
): Promise<void> {
  await link.conn.write(encodePaddingNegotiate(PADDING_START, lowMs, highMs));
}

/** Ask the peer to stop. */
export async function stopPadding(link: Link): Promise<void> {
  await link.conn.write(encodePaddingNegotiate(PADDING_STOP, 0, 0));
}

/**
 * Send padding whenever the link has been quiet, until `stop()` is called.
 *
 * The interval is redrawn every time rather than fixed, because a fixed one is itself a
 * pattern: a cell every 5000ms exactly is more distinctive than no cell at all, and the
 * point is to make the flow look ordinary rather than to make it look padded.
 *
 * The caller must call `touch()` whenever it sends something, so real traffic resets the
 * timer. Padding on top of a busy link would be waste rather than protection — there is no
 * gap to fill.
 */
export function padWhenIdle(
  link: Link,
  opts: { lowMs?: number; highMs?: number; random?: () => number } = {},
): { touch: () => void; stop: () => void } {
  const low = opts.lowMs ?? NF_ITO_LOW_MS;
  const high = opts.highMs ?? NF_ITO_HIGH_MS;
  const random = opts.random ?? Math.random;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const arm = () => {
    if (stopped) return;
    const delay = low + random() * (high - low);
    timer = setTimeout(async () => {
      if (stopped) return;
      try {
        await link.conn.write(encodePadding());
      } catch {
        // The link has gone. Nothing to pad, and nothing useful to report from a timer.
        stopped = true;
        return;
      }
      arm();
    }, delay);
    // Padding is not a reason to keep the process alive; if nothing else is running there
    // is no traffic pattern left to protect.
    Deno.unrefTimer(timer);
  };

  arm();
  return {
    touch: () => {
      if (timer !== undefined) clearTimeout(timer);
      arm();
    },
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
