import { isVenicePromoEnabled } from "@/lib/venice/promo-flag";
import styles from "@/app/venice/venice.module.css";

export const VENICE_PROMO_CODE = "VENICE";

/** The launch offer. Renders nothing unless NEXT_PUBLIC_HIVRA_VENICE_PROMO_ENABLED is "true". */
export default function VenicePromo() {
  if (!isVenicePromoEnabled()) return null;
  return (
    <p className={styles.promo} data-venice-promo="">
      New to Hivra? Get $10 of Venice inference with code <strong>{VENICE_PROMO_CODE}</strong>
    </p>
  );
}
