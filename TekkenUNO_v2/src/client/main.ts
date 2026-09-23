// 画面の入口
import "./styles.css";
import { initNet } from "./net.js";
import { S, onChange, renderNow } from "./store.js";
import { toast } from "./ui/common.js";
import { mountEntry, updateEntry } from "./ui/entry.js";
import { capture, playEvents } from "./ui/events.js";
import { mountRoom, resetRoom, updateRoom } from "./ui/room.js";

const app = document.getElementById("app")!;
let screen: "entry" | "room" | null = null;

function render() {
  if (S.view) {
    if (screen !== "room") {
      screen = "room";
      resetRoom();
      app.replaceChildren(mountRoom());
    }
    updateRoom();
  } else {
    if (screen !== "entry") {
      screen = "entry";
      resetRoom();
      app.replaceChildren(mountEntry());
    }
    updateEntry();
  }
}

onChange(render);

initNet({
  state(view, ev) {
    const prev = S.view;
    const pre = capture(ev, view.you);
    if (view.matches) S.matches = view.matches;
    S.view = view;
    renderNow();
    playEvents(pre, ev, prev, view);
  },
  error(m) {
    toast(m, "err");
  },
  out(why) {
    S.matches = [];
    if (why === "kicked") {
      S.notice = "ホストにキックされたため、部屋から出ました。";
      toast("ホストにキックされました", "err", 4000);
    } else S.notice = "";
  },
});

render();

// ダブルタップでの拡大を防ぐ（iOS）
let lastTouch = 0;
document.addEventListener(
  "touchend",
  (e) => {
    const t = Date.now();
    if (t - lastTouch < 350 && (e.target as HTMLElement).closest("button, .card")) e.preventDefault();
    lastTouch = t;
  },
  { passive: false },
);
