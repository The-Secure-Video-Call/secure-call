import type { ConnectionQuality } from '@/rtc/connectionQuality';

const LEVEL_LABEL = {
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  unknown: 'Checking…',
} as const;

/** Describes the numbers in words; contains no addresses. */
export function describeConnectionQuality(connectionQuality: ConnectionQuality): string {
  const descriptionParts: string[] = [
    `Connection quality: ${LEVEL_LABEL[connectionQuality.level]}`,
  ];
  if (connectionQuality.packetLossPercent !== null) {
    descriptionParts.push(`packet loss ${connectionQuality.packetLossPercent.toFixed(1)}%`);
  }
  if (connectionQuality.roundTripTimeMilliseconds !== null) {
    descriptionParts.push(
      `round trip ${Math.round(connectionQuality.roundTripTimeMilliseconds)} ms`,
    );
  }
  if (connectionQuality.isViaRelay) descriptionParts.push('via relay');
  return descriptionParts.join(', ');
}

/** A coloured dot plus a text label (never colour alone) and the numbers as text. */
export function ConnectionQualityIndicator(props: { connectionQuality: ConnectionQuality }) {
  const { connectionQuality } = props;
  return (
    <p
      className={`connection-quality connection-quality-${connectionQuality.level}`}
      title={describeConnectionQuality(connectionQuality)}
    >
      <span className="connection-quality-dot" aria-hidden="true" />
      <span aria-hidden="true">
        {LEVEL_LABEL[connectionQuality.level]}
        {connectionQuality.isViaRelay ? ' (via relay)' : ''}
      </span>
      <span className="visually-hidden">{describeConnectionQuality(connectionQuality)}</span>
    </p>
  );
}
