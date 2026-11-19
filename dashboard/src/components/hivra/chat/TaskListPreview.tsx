"use client";

// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
//
// The agent's task list (its TodoWrite call) as MonoCode's task card: a header
// with the progress, then one row per task with its state.

import { Check, ListEnd, Loader, Minus } from "lucide-react";
import { taskListProgressLabel, type TaskItem, type TaskStatus } from "./toolInput";
import styles from "./chat.module.css";

function TaskState({ status }: { status: TaskStatus }) {
  if (status === "completed") {
    return <span role="img" aria-label="Completed" className={`${styles.taskState} ${styles.taskDone}`}><Check size={10} strokeWidth={2.5} aria-hidden /></span>;
  }
  if (status === "in_progress") {
    return <span role="img" aria-label="In progress" className={`${styles.taskState} ${styles.taskActive}`}><Loader size={16} strokeWidth={2} aria-hidden className={styles.taskSpin} /></span>;
  }
  if (status === "cancelled") {
    return <span role="img" aria-label="Cancelled" className={`${styles.taskState} ${styles.taskCancelled}`}><Minus size={10} strokeWidth={2} aria-hidden /></span>;
  }
  return <span role="img" aria-label="Pending" className={`${styles.taskState} ${styles.taskPending}`} />;
}

export function TaskListPreview({ items }: { items: readonly TaskItem[] }) {
  return (
    <section aria-label="Task progress" className={styles.tasks}>
      <div className={styles.tasksHead}>
        <ListEnd size={16} strokeWidth={1.75} aria-hidden className={styles.tasksIcon} />
        <h3 className={styles.tasksTitle}>Tasks</h3>
        <span className={styles.tasksCount}>{taskListProgressLabel(items)}</span>
      </div>
      <ol className={styles.tasksList}>
        {items.map((item, index) => (
          <li key={item.id ?? `${index}:${item.text}`} className={styles.taskRow}>
            <TaskState status={item.status} />
            <span className={`${styles.taskText} ${item.status === "completed" ? styles.taskTextDone : item.status === "cancelled" ? styles.taskTextCancelled : item.status === "in_progress" ? styles.taskTextActive : ""}`}>
              {item.text}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
