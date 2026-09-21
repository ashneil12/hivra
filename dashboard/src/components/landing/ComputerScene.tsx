"use client";

import { useRef, useState, type PointerEvent } from "react";
import { ArrowUpRight, Folder, Monitor, Terminal } from "lucide-react";
import { HivraMark } from "@/components/branding/HivraMark";
import styles from "./home.module.css";

const views = [
  { name: "Desktop", icon: Monitor, caption: "A workspace you can make your own." },
  { name: "Terminal", icon: Terminal, caption: "Your tools. A terminal underneath." },
  { name: "Files", icon: Folder, caption: "Keep your work with your computer." },
] as const;

/** An illustration; never presents a live agent or session. */
export default function ComputerScene() {
  const [view, setView] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  function move(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "mouse" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const rect = event.currentTarget.getBoundingClientRect();
    stage.current?.style.setProperty("--scene-x", `${(event.clientX - rect.left) / rect.width * 8 - 4}deg`);
    stage.current?.style.setProperty("--scene-y", `${4 - (event.clientY - rect.top) / rect.height * 8}deg`);
  }
  function reset() {
    stage.current?.style.setProperty("--scene-x", "0deg");
    stage.current?.style.setProperty("--scene-y", "0deg");
  }
  return (
    <div className={styles.scene} onPointerMove={move} onPointerLeave={reset}>
      <div className={styles.sceneMeta}><span>HIVRA / COMPUTER</span><span>01—03</span></div>
      <div className={styles.sceneStage} ref={stage} data-view={view}>
        <div className={styles.sceneOrbit} aria-hidden="true" />
        <div className={styles.sceneOrbitTwo} aria-hidden="true" />
        <div className={styles.sceneFloor} aria-hidden="true"><span /><span /><span /></div>
        <div className={styles.computerWindow}>
          <div className={styles.windowBar}><span className={styles.windowDots} aria-hidden="true"><i /><i /><i /></span><span>your-computer</span><ArrowUpRight size={13} aria-hidden="true" /></div>
          <div className={styles.windowContent}>
            {view === 0 && <div className={styles.desktopView}><div className={styles.desktopBrand}><HivraMark size={76} /><span>Room to work.</span></div><div className={styles.desktopDock} aria-hidden="true"><Monitor /><Terminal /><Folder /></div></div>}
            {view === 1 && <div className={styles.terminalView}><p><span>~/workspace</span> $ ls</p><p>projects/ &nbsp; notes/ &nbsp; tools/</p><br /><p><span>~/workspace</span> $ <i className={styles.cursor} /></p></div>}
            {view === 2 && <div className={styles.filesView}>{["Projects", "Notes", "Tools"].map(name => <div key={name}><Folder size={24} /><span>{name}</span><span>Folder</span></div>)}</div>}
          </div>
        </div>
        <div className={styles.machineBase} aria-hidden="true"><HivraMark size={30} /><span>HIVRA</span><i /></div>
        <span className={styles.sceneCoordinate} aria-hidden="true">A SPACE OF ITS OWN</span>
      </div>
      <div className={styles.sceneControls} role="group" aria-label="Explore the computer illustration">
        {views.map(({ name, icon: Icon }, index) => <button key={name} type="button" aria-pressed={view === index} onClick={() => setView(index)}><Icon size={15} aria-hidden="true" />{name}</button>)}
      </div>
      <div className={styles.sceneCaption}><span aria-live="polite">{views[view].caption}</span><small>Interactive illustration</small></div>
    </div>
  );
}
