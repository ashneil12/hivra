'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import QRCode from 'qrcode';

interface LocalAddressQrProps {
  address: string;
  size?: number;
  label?: string;
  style?: CSSProperties;
}

export function LocalAddressQr({
  address,
  size = 164,
  label = 'Deposit address QR code',
  style,
}: LocalAddressQrProps) {
  const [qr, setQr] = useState<{ address: string; src: string } | null>(null);
  const frameSize = size + 8;
  const currentSrc = qr?.address === address ? qr.src : null;

  useEffect(() => {
    if (!address) {
      return;
    }

    let cancelled = false;
    QRCode.toDataURL(address, { margin: 1, width: size })
      .then((value) => {
        if (!cancelled) setQr({ address, src: value });
      })
      .catch(() => {
        if (!cancelled) setQr(null);
      });

    return () => {
      cancelled = true;
    };
  }, [address, size]);

  return (
    <div
      aria-label={label}
      style={{
        width: frameSize,
        height: frameSize,
        border: '1px solid var(--etched-border)',
        background: 'var(--bg-surface)',
        display: 'grid',
        placeItems: 'center',
        alignSelf: 'center',
        flex: `0 0 ${frameSize}px`,
        ...style,
      }}
    >
      {currentSrc ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={currentSrc} alt={label} width={size} height={size} />
      ) : (
        <span className="mono" style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
          QR
        </span>
      )}
    </div>
  );
}
