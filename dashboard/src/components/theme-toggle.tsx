"use client"

import * as React from "react"
import { Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"

const THEME_TRANSITION_CLASS = "theme-transition"
const THEME_TRANSITION_MS = 600
let themeTransitionTimer: number | undefined

/**
 * Switch theme with the colour fade. Touch devices only fade while this class
 * is on <html> (see globals.css), so taps elsewhere get instant feedback.
 */
export function switchThemeWithTransition(setTheme: (theme: string) => void, theme: string) {
  const root = document.documentElement
  root.classList.add(THEME_TRANSITION_CLASS)
  window.clearTimeout(themeTransitionTimer)
  themeTransitionTimer = window.setTimeout(() => root.classList.remove(THEME_TRANSITION_CLASS), THEME_TRANSITION_MS)
  setTheme(theme)
}

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return <div className="hivra-theme-toggle" aria-hidden="true" /> // placeholder
  }

  return (
    <button
      type="button"
      className="hivra-theme-toggle"
      onClick={() => switchThemeWithTransition(setTheme, resolvedTheme === "dark" ? "light" : "dark")}
      title={resolvedTheme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    >
      {resolvedTheme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
      <span className="sr-only">Toggle theme</span>
    </button>
  )
}
