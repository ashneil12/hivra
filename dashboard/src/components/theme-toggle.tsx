"use client"

import * as React from "react"
import { Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return <div style={{ width: 24, height: 24 }} /> // placeholder
  }

  return (
    <button
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      title={resolvedTheme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      style={{
        width: 32,
        height: 32,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        color: 'var(--text-secondary)',
        background: 'transparent',
        border: 'none',
        transition: 'all 0.2s ease',
        borderRadius: 0
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = 'var(--ink-black)';
        e.currentTarget.style.background = 'var(--border-subtle)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = 'var(--text-secondary)';
        e.currentTarget.style.background = 'transparent';
      }}
    >
      {resolvedTheme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
      <span className="sr-only">Toggle theme</span>
    </button>
  )
}
