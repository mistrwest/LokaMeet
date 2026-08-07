import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type SelectOption = {
  value: string;
  label: string;
};

type SelectProps = {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
  title?: string;
  style?: React.CSSProperties;
  "aria-label"?: string;
};

type MenuPos = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  up: boolean;
};

export function Select(props: SelectProps) {
  const { value, options, onChange, className, disabled, title, style } = props;
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const [activeIdx, setActiveIdx] = useState(-1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  const selected = useMemo(
    () => options.find((o) => o.value === value) ?? options[0] ?? { value: "", label: "" },
    [options, value]
  );

  const updatePos = () => {
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const maxMenu = 240;
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    // Меню открывается вверх при нехватке места снизу, чтобы не обрезаться краем окна.
    const up = spaceBelow < Math.min(maxMenu, 160) && spaceAbove > spaceBelow;
    const maxHeight = Math.max(120, Math.min(maxMenu, up ? spaceAbove : spaceBelow));
    const top = up ? Math.max(8, rect.top - maxHeight - 4) : rect.bottom + 4;
    setPos({
      left: rect.left,
      top,
      width: Math.max(rect.width, 120),
      maxHeight,
      up
    });
  };

  useEffect(() => {
    if (!open) return;
    // Портал выводит меню за пределы root, поэтому клик вне обеих областей закрывает его явно.
    const onDoc = (e: MouseEvent) => {
      const root = rootRef.current;
      const menu = menuRef.current;
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (root?.contains(t) || menu?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onReposition = () => updatePos();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    updatePos();
    const idx = Math.max(0, options.findIndex((o) => o.value === value));
    setActiveIdx(idx);
  }, [open, options, value]);

  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(options.length - 1, (i < 0 ? 0 : i) + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, (i < 0 ? 0 : i) - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = options[activeIdx];
      if (opt) pick(opt.value);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIdx(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIdx(options.length - 1);
    }
  };

  const wrapClass = ["select", className].filter(Boolean).join(" ");

  const menu =
    open && !disabled && pos
      ? createPortal(
          <div
            ref={menuRef}
            id={listId}
            className="selectMenu"
            role="listbox"
            tabIndex={-1}
            data-up={pos.up ? "1" : "0"}
            style={{
              position: "fixed",
              left: pos.left,
              top: pos.top,
              width: pos.width,
              maxHeight: pos.maxHeight,
              right: "auto",
              bottom: "auto"
            }}
            onKeyDown={onMenuKeyDown}
          >
            {options.map((opt, idx) => (
              <button
                key={`${opt.value}::${idx}`}
                type="button"
                role="option"
                className="selectOption"
                aria-selected={opt.value === value}
                data-selected={opt.value === value ? "1" : "0"}
                data-active={idx === activeIdx ? "1" : "0"}
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => pick(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>,
          document.body
        )
      : null;

  return (
    <div ref={rootRef} className={wrapClass} style={style} title={title}>
      <button
        type="button"
        className="selectTrigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={props["aria-label"]}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="selectValue">{selected.label}</span>
        <span className="selectChevron" aria-hidden>
          ▾
        </span>
      </button>
      {menu}
    </div>
  );
}
