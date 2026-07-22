import type { DeliveryStats } from '@/types/api';
import { CIRCUIT_TONE } from '@/lib/palette';
import { compactNumber, formatInt, formatMs, humanizeKind } from '@/lib/format';
import { Badge, Panel, StatTile } from '@/components/ui/primitives';

/**
 * Delivery-adapter view: the backpressure and outcome picture between the
 * simulator and the target (in-flight, queue depth, circuit-breaker state, and
 * the delivery latency percentiles that the adapter measures end-to-end).
 */
export function DeliveryPanel({ delivery }: { delivery: DeliveryStats }): React.JSX.Element {
  return (
    <Panel
      title="Delivery adapter"
      icon="send"
      actions={
        <Badge tone={CIRCUIT_TONE[delivery.circuit]} icon="plug">
          Circuit {humanizeKind(delivery.circuit)}
        </Badge>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="In flight" value={formatInt(delivery.inFlight)} icon="send" />
        <StatTile label="Queue depth" value={compactNumber(delivery.queueDepth)} icon="database" tone={delivery.queueDepth > 0 ? 'warning' : 'neutral'} />
        <StatTile label="Delivered" value={compactNumber(delivery.deliveredTotal)} icon="check" tone="good" />
        <StatTile label="Dropped" value={compactNumber(delivery.droppedTotal)} icon="alert" tone={delivery.droppedTotal > 0 ? 'warning' : 'neutral'} />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-3">
        <StatTile label="Latency p50" value={formatMs(delivery.latency.p50)} />
        <StatTile label="Latency p95" value={formatMs(delivery.latency.p95)} />
        <StatTile label="Latency p99" value={formatMs(delivery.latency.p99)} tone={delivery.latency.p99 > 1000 ? 'warning' : 'neutral'} />
      </div>
    </Panel>
  );
}
