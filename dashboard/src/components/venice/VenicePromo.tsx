import { ArrowRight } from "lucide-react";
import CopyPromoCode from "@/components/venice/CopyPromoCode";
import { isVenicePromoBannerEnabled } from "@/lib/venice/promo-flag";
import { buildVeniceLaunchHref } from "@/lib/venice/launch-link";
import styles from "./venice-promo.module.css";

export const VENICE_PROMO_CODE = "VENICE";

export default function VenicePromo() {
  if (!isVenicePromoBannerEnabled()) return null;
  return (
    <aside className={styles.promo} data-venice-promo="" aria-labelledby="venice-promo-title">
      <div className={styles.offer}>
        <span className={styles.eyebrow}><span className={styles.dot} aria-hidden="true" />Launch offer · New to Hivra</span>
        <h2 className={styles.headline} id="venice-promo-title">
          <span className={styles.amount}>$10</span>
          <span>of Venice inference, on us</span>
        </h2>
        <p className={styles.body}>
          Start a plan and launch your agent with Hivra credits. We add $10 to your balance for it to spend on Venice models.
        </p>
      </div>
      <div className={styles.ticket}>
        <span className={styles.ticketLabel}>Your code</span>
        <CopyPromoCode code={VENICE_PROMO_CODE} />
        <a className={styles.claim} href={buildVeniceLaunchHref("hermes", "venice", "venice", VENICE_PROMO_CODE)} data-cta="venice-promo-claim">
          Claim your $10 <ArrowRight size={16} aria-hidden="true" />
        </a>
        <p className={styles.fine}>One per account. Unused promo credit expires 30 days after it is added.</p>
      </div>
    </aside>
  );
}
