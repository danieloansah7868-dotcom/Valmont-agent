"use client";

import { useEffect, useRef, useState } from "react";
import type { OrderRecord } from "@/lib/studio/orders";

const SEEN_KEY = "valmont:orders:seen-at";
const SOUND_KEY = "valmont:orders:sound";

function playChime() {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
    window.setTimeout(() => void ctx.close(), 300);
  } catch {
    /* ignore autoplay blocks */
  }
}

/**
 * While Studio is open, poll for newer orders and ping the tab title (and an
 * optional chime) so the merchant notices without refreshing.
 */
function readSoundPref(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SOUND_KEY) !== "0";
  } catch {
    return true;
  }
}

function readSeenAt(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

export function OrderAlerts() {
  const [soundOn, setSoundOn] = useState(readSoundPref);
  const [flash, setFlash] = useState<string | null>(null);
  const titleRef = useRef<string | null>(null);
  const seenRef = useRef<string | null>(readSeenAt());

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const response = await fetch("/api/studio/orders?limit=5", {
          cache: "no-store",
        });
        if (!response.ok) return;
        const data = (await response.json()) as { orders?: OrderRecord[] };
        const newest = data.orders?.[0];
        if (!newest || cancelled) return;
        if (!seenRef.current) {
          seenRef.current = newest.createdAt;
          try {
            window.sessionStorage.setItem(SEEN_KEY, newest.createdAt);
          } catch {
            /* ignore */
          }
          return;
        }
        if (newest.createdAt > seenRef.current) {
          seenRef.current = newest.createdAt;
          try {
            window.sessionStorage.setItem(SEEN_KEY, newest.createdAt);
          } catch {
            /* ignore */
          }
          const label = `(1) New order · ${newest.customerName}`;
          setFlash(label);
          if (soundOn) playChime();
        }
      } catch {
        /* offline / signed out */
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 12_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [soundOn]);

  useEffect(() => {
    if (!flash) return;
    if (!titleRef.current) titleRef.current = document.title;
    let on = true;
    document.title = flash;
    const timer = window.setInterval(() => {
      document.title = on ? titleRef.current! : flash;
      on = !on;
    }, 1200);
    return () => {
      window.clearInterval(timer);
      if (titleRef.current) document.title = titleRef.current;
    };
  }, [flash]);

  return (
    <div className="flex items-center justify-end gap-2 px-4 pt-3 sm:px-6">
      <label className="flex items-center gap-2 text-xs text-slate-600">
        <input
          type="checkbox"
          checked={soundOn}
          onChange={(event) => {
            setSoundOn(event.target.checked);
            try {
              window.localStorage.setItem(
                SOUND_KEY,
                event.target.checked ? "1" : "0",
              );
            } catch {
              /* ignore */
            }
          }}
        />
        Play a sound for new orders
      </label>
    </div>
  );
}
