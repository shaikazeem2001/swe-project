"use client";

import { useActionState } from "react";
import { saveFavoriteMovie, type OnboardingState } from "./actions";

const initialState: OnboardingState = {};

export function OnboardingForm() {
  const [state, formAction, pending] = useActionState(saveFavoriteMovie, initialState);

  return (
    <form action={formAction} className="w-full max-w-md space-y-3">
      <input
        name="title"
        type="text"
        defaultValue={state.value}
        placeholder="e.g. Inception"
        autoFocus
        required
        maxLength={100} // UX only — the server is the source of truth
        aria-invalid={!!state.error}
        aria-describedby={state.error ? "title-error" : undefined}
        className="w-full rounded-lg border border-neutral-300 bg-transparent px-4 py-3 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:focus:border-white"
      />
      {state.error && (
        <p id="title-error" role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-neutral-900 px-4 py-3 font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {pending ? "Saving…" : "Continue"}
      </button>
    </form>
  );
}
