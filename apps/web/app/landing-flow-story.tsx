"use client";

import { type ReactNode, useEffect, useRef } from "react";

const reducedMotion = "(prefers-reduced-motion: reduce)";

export function FlowStory({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const steps = [
      ...root.querySelectorAll<HTMLElement>(".flow-sequence > li"),
    ];
    const details = [
      ...root.querySelectorAll<HTMLElement>(".flow-detail-list > li"),
    ];
    const motion = window.matchMedia(reducedMotion);

    const clearCurrent = () => {
      for (const step of steps) step.removeAttribute("aria-current");
      for (const detail of details) detail.removeAttribute("data-active");
    };

    const activate = (index: number) => {
      steps.forEach((step, stepIndex) => {
        if (stepIndex === index) step.setAttribute("aria-current", "step");
        else step.removeAttribute("aria-current");
      });
      details.forEach((detail, detailIndex) => {
        if (detailIndex === index) detail.setAttribute("data-active", "");
        else detail.removeAttribute("data-active");
      });
    };

    let observer: IntersectionObserver | undefined;

    const syncMotion = () => {
      observer?.disconnect();
      observer = undefined;
      if (motion.matches) {
        root.dataset.motion = "reduced";
        clearCurrent();
        return;
      }
      root.dataset.motion = "full";
      activate(0);
      observer = new IntersectionObserver(
        (entries) => {
          const visible = entries
            .filter((entry) => entry.isIntersecting)
            .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
          if (!visible) return;
          const index = details.indexOf(visible.target as HTMLElement);
          if (index >= 0) activate(index);
        },
        { rootMargin: "-28% 0px -42% 0px", threshold: [0.25, 0.6, 0.9] },
      );
      for (const detail of details) observer.observe(detail);
    };

    syncMotion();
    motion.addEventListener("change", syncMotion);
    return () => {
      observer?.disconnect();
      motion.removeEventListener("change", syncMotion);
    };
  }, []);

  return (
    <div className="flow-story" ref={rootRef}>
      {children}
    </div>
  );
}
