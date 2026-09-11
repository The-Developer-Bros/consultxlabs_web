"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface BreadcrumbOverrideContextValue {
  /** Optional label replacing a stripped record-id crumb (e.g. appointment title). */
  overrideLabel: string | null;
  setOverrideLabel: (label: string | null) => void;
}

const BreadcrumbOverrideContext =
  createContext<BreadcrumbOverrideContextValue | null>(null);

export function BreadcrumbOverrideProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [overrideLabel, setOverrideLabelState] = useState<string | null>(null);
  const setOverrideLabel = useCallback((label: string | null) => {
    setOverrideLabelState(label);
  }, []);

  const value = useMemo(
    () => ({ overrideLabel, setOverrideLabel }),
    [overrideLabel, setOverrideLabel],
  );

  return (
    <BreadcrumbOverrideContext.Provider value={value}>
      {children}
    </BreadcrumbOverrideContext.Provider>
  );
}

export function useBreadcrumbOverride() {
  const ctx = useContext(BreadcrumbOverrideContext);
  if (!ctx) {
    return {
      overrideLabel: null as string | null,
      setOverrideLabel: (_label: string | null) => {},
    };
  }
  return ctx;
}

/** Sets the breadcrumb override while mounted; clears on unmount. */
export function useSetBreadcrumbLabel(label: string | null | undefined) {
  const { setOverrideLabel } = useBreadcrumbOverride();
  useEffect(() => {
    if (!label) return;
    setOverrideLabel(label);
    return () => setOverrideLabel(null);
  }, [label, setOverrideLabel]);
}
