"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type FactSource = "cache" | "generated" | "stale";
type FactResponse = {
  fact: { id: string; content: string; createdAt: string };
  source: FactSource;
};
type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: FactResponse };

const HINTS: Record<FactSource, string> = {
  generated: "Freshly generated.",
  cache: "Served from cache. A new fact can be generated 60 seconds after the last one.",
  stale: "We couldn't reach OpenAI, so this is an earlier fact.",
};

export function FactCard() {
  const [state, setState] = useState<State>({ status: "loading" });
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current; // ignore out-of-order responses
    setState({ status: "loading" });
    try {
      const res = await fetch("/api/fact", { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (id !== requestId.current) return;
      if (!res.ok) {
        setState({
          status: "error",
          message: body?.error ?? "Could not load a fact.",
        });
        return;
      }
      setState({ status: "ready", data: body as FactResponse });
    } catch {
      if (id !== requestId.current) return;
      setState({ status: "error", message: "Network error. Please try again." });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section
      aria-live="polite"
      className="space-y-3 rounded-2xl border border-neutral-200 p-6 dark:border-neutral-800"
    >
      <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
        Fun fact
      </h2>

      {state.status === "loading" && (
        <p className="animate-pulse text-neutral-500">Finding a fun fact…</p>
      )}

      {state.status === "error" && (
        <p role="alert" className="text-red-600">
          {state.message}
        </p>
      )}

      {state.status === "ready" && (
        <>
          <p className="text-lg leading-relaxed">{state.data.fact.content}</p>
          <p className="text-xs text-neutral-500">{HINTS[state.data.source]}</p>
        </>
      )}

      <button
        type="button"
        onClick={() => void load()}
        disabled={state.status === "loading"}
        className="rounded-lg border border-neutral-300 px-4 py-2 text-sm transition hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
      >
        {state.status === "error" ? "Try again" : "New fact"}
      </button>
    </section>
  );
}
