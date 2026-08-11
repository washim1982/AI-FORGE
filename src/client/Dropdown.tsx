import { useState, useRef, useEffect } from "react";
import { ChevronDown, Check } from "lucide-react";

export interface DropdownOption {
  value: string;
  label: string;
  description?: string;
}

interface DropdownProps {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
  align?: "left" | "right" | "top" | "top-right";
}

export function Dropdown({ value, options, onChange, className = "", disabled = false, align = "left" }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const selected = options.find((opt) => opt.value === value) || options[0];

  return (
    <div className={`custom-dropdown ${className} ${disabled ? "disabled" : ""}`} ref={containerRef}>
      <button 
        type="button"
        className="dropdown-trigger" 
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
      >
        <span>{selected?.label || "Select..."}</span>
        <ChevronDown size={14} />
      </button>
      
      {open && (
        <div className={`dropdown-menu align-${align}`}>
          {options.length === 0 && (
            <div className="dropdown-empty">No options</div>
          )}
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`dropdown-item ${option.value === value ? "selected" : ""}`}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <div className="item-icon-space">
                {option.value === value && <Check size={14} />}
              </div>
              <div className="item-content">
                <div className="item-label">{option.label}</div>
                {option.description && <div className="item-description">{option.description}</div>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
