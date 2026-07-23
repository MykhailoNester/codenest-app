import { type ReactElement } from "react";
import { Shell } from "../../components/layout/shell";
import { ActivityPulse } from "../../components/dashboard/overview/activity-pulse";
import { KpiStack } from "../../components/dashboard/overview/kpi-stack";
import { ActiveSessions } from "../../components/dashboard/overview/active-sessions";
import { ProjectsPulse } from "../../components/dashboard/overview/projects-pulse";
import { MomentumTimeline } from "../../components/dashboard/overview/momentum-timeline";
import styles from "./overview-page.module.css";

export function OverviewPage(): ReactElement {
  return (
    <Shell topbarTitle="Overview">
      <div className={styles.page}>
        {/* HERO: Activity Pulse (left) + KPI Stack (right) */}
        <section className={styles.hero}>
          <ActivityPulse />
          <KpiStack />
        </section>

        {/* LIVE: Active Sessions (left) + Projects Pulse (right) */}
        <section className={styles.live}>
          <ActiveSessions />
          <ProjectsPulse />
        </section>

        {/* MOMENTUM: Full-width 24h timeline */}
        <MomentumTimeline />
      </div>
    </Shell>
  );
}
