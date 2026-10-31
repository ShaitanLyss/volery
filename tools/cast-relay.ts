/* A stand-in for `cast::local`'s loopback socket, for building the front end
 * of screens before (and apart from) the real capture.
 *
 *   bun tools/cast-relay.ts [port]        # default 14399
 *
 * Two kinds of client: `/host` — `tools/castlab.ts`'s encoder, which produces
 * the same wire messages `src-tauri/src/cast/wire.rs` does — and `/view`, the
 * real `cast.worker.ts`. Everything one says is forwarded to the other,
 * untouched, binary and text alike, so the worker meets exactly the bytes the
 * contract promises and the encoder hears exactly the wants and key requests
 * the worker sends. No API turn, no wall, no Rust.
 *
 * Forwarding never queues: a viewer whose socket is backed up has the frame
 * dropped, which is the contract's own rule (`docs/SCREENS.md`, *send must never
 * block*) and is what lets the worker's drop-to-the-next-keyframe path be seen.
 */

const port = Number(process.argv[2] ?? 14399);
type Side = "host" | "view";
const peers: Record<Side, Set<Bun.ServerWebSocket<{ side: Side }>>> = { host: new Set(), view: new Set() };
let forwarded = 0;
let dropped = 0;

Bun.serve<{ side: Side }, never>({
  port,
  hostname: "127.0.0.1",
  fetch(req, server) {
    const side = new URL(req.url).pathname.startsWith("/host") ? "host" : "view";
    if (server.upgrade(req, { data: { side } })) return;
    return new Response("cast relay: dial /host or /view", { status: 400 });
  },
  websocket: {
    open(ws) {
      peers[ws.data.side].add(ws);
      console.log(`${ws.data.side} connected (${peers.host.size} host, ${peers.view.size} view)`);
      /* A viewer arriving asks for a keyframe on its own once it opens; the
         host is also told someone is here, so it can start at all. */
      if (ws.data.side === "view") for (const h of peers.host) h.send(JSON.stringify({ t: "viewer" }));
    },
    message(ws, msg) {
      const to = ws.data.side === "host" ? peers.view : peers.host;
      for (const p of to) {
        /* Back-pressure: past ~2 MB unsent, a frame is worth nothing. Text
           (config, state, want) always goes. */
        if (typeof msg !== "string" && p.getBufferedAmount() > 2_000_000) {
          dropped++;
          continue;
        }
        p.send(msg);
        forwarded++;
      }
    },
    close(ws) {
      peers[ws.data.side].delete(ws);
      console.log(`${ws.data.side} left`);
    },
  },
});

setInterval(() => {
  if (forwarded || dropped) console.log(`forwarded ${forwarded}, dropped ${dropped}`);
  forwarded = 0;
  dropped = 0;
}, 5000);

console.log(`cast relay on ws://127.0.0.1:${port} — /host and /view`);
