import { useEffect, useState } from "react";
import { api } from "../../api";
import unknownAltIcon from "../../assets/UnknownALT-icon.png";
import { setSplashPhase, type SplashPhase } from "./phase";
import "./splash.css";

/** When the window grows: the animation settles at 3 s (79% of 3.8 s), then holds 2 s. */
const GROW_MS = 3000 + 2000;
/** Set once the splash has run: a webview reload doesn't play it again. */
const KEY = "UnknownAlt.splash";

/** Temporary glitch layers use the same unmodified mascot as the settled image. */
function MascotLayer({ className }: { className: string }) {
  return (
    <img className={className} src={unknownAltIcon} width="120" height="120" alt="" aria-hidden="true" draggable={false} />
  );
}

function seen() {
  // A dev preview with ?splash=1 plays it again.
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("splash")) return false;
  // Settings.skip_splash, from `main_window`: the window is already full size.
  if ((window as { __UNKNOWNALT_SKIP_SPLASH?: boolean }).__UNKNOWNALT_SKIP_SPLASH) return true;
  try {
    const current = sessionStorage.getItem(KEY);
    if (current !== null) return true;
    // Compatibility for a WebView session that survived an older branded build.
    const legacy = sessionStorage.getItem("roalt.splash");
    if (legacy !== null) {
      sessionStorage.setItem(KEY, legacy);
      sessionStorage.removeItem("roalt.splash");
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Decided before anything renders, so the island knows to wait for it.
const FIRST: SplashPhase = seen() ? "gone" : "play";
setSplashPhase(FIRST);

/** The start-up splash over the app: the tile glitches into the UnknownAlt mark, then the window
 * (opened small by `splash::start`) grows into the app and this fades away. */
export function Splash() {
  const [state, setState] = useState<SplashPhase>(FIRST);

  useEffect(() => setSplashPhase(state), [state]);

  useEffect(() => {
    if (state !== "play") return;
    // Plays even with Windows' animation effects off (theme.css leaves the splash out).
    const grow = () => {
      try {
        sessionStorage.setItem(KEY, "1");
      } catch {
        // No storage: a reload plays it again.
      }
      // Fades once the window has grown, even if growing failed.
      api.splashDone().finally(() => setState("out"));
    };
    const t = setTimeout(grow, GROW_MS);
    return () => clearTimeout(t);
  }, [state]);

  // A background window or reduced motion may never dispatch transitionend.
  useEffect(() => {
    if (state !== "out") return;
    const done = setTimeout(() => setState("gone"), 600);
    return () => clearTimeout(done);
  }, [state]);

  if (state === "gone") return null;
  return (
    <div
      className={`splash ${state === "out" ? "out" : ""}`}
      data-tauri-drag-region
      onTransitionEnd={(e) => e.target === e.currentTarget && setState("gone")}
      aria-hidden="true"
    >
      <div className="mark" data-tauri-drag-region>
        <div className="logo">
          <MascotLayer className="cube" />
          <div className="tile">
            <MascotLayer className="red" />
            <MascotLayer className="cyan" />
            <MascotLayer className="core" />
            <MascotLayer className="slice-a" />
            <MascotLayer className="slice-b" />
          </div>
        </div>
      </div>
      <div className="mark">
        <div className="word">
          <b>UnknownALT</b>
          <span>v{import.meta.env.APP_VERSION}</span>
        </div>
      </div>
      <div className="scan" />
    </div>
  );
}

