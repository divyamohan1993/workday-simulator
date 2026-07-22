import { useEffect } from 'react';
import { useTelemetryStore } from '@/store/telemetry-store';
import { useUiStore } from '@/store/ui-store';
import { api } from '@/lib/services';
import { Button, EmptyState, Panel } from '@/components/ui/primitives';
import { RpsChart, LatencyChart, ErrorRateChart } from '@/components/charts/TimeSeriesCharts';
import { EventMixDonut } from '@/components/charts/DistributionCharts';
import { HeroStrip } from '@/components/dashboard/HeroStrip';
import { EventTicker } from '@/components/dashboard/EventTicker';
import { ReceiverPanel } from '@/components/dashboard/ReceiverPanel';
import { DeliveryPanel } from '@/components/dashboard/DeliveryPanel';
import { ChaosBanner } from '@/components/dashboard/ChaosBanner';

/**
 * The live operations view. Everything renders from the once-per-second
 * TelemetryFrame in the store, so the update rate stays bounded no matter how
 * many events/sec the run produces. On mount it seeds from GET /api/telemetry/current
 * so a dashboard opened mid-run paints immediately instead of waiting a frame.
 */
export default function LiveDashboard(): React.JSX.Element {
  const frame = useTelemetryStore((s) => s.frame);
  const run = useTelemetryStore((s) => s.run);
  const points = useTelemetryStore((s) => s.points);
  const ticker = useTelemetryStore((s) => s.ticker);
  const setView = useUiStore((s) => s.setView);

  useEffect(() => {
    const controller = new AbortController();
    api
      .getCurrentTelemetry(controller.signal)
      .then((current) => {
        if (current) useTelemetryStore.getState().ingestFrame(current);
      })
      .catch(() => {
        /* WS frames will populate shortly; a failed bootstrap is non-fatal. */
      });
    return () => controller.abort();
  }, []);

  if (!frame) {
    return (
      <Panel title="Live operations" icon="activity" accent>
        <EmptyState
          icon="activity"
          title="No live telemetry yet"
          message="Telemetry streams here while a run is active. Compose a scenario and start a run to light up the control room."
          action={
            <Button variant="primary" iconRight="arrowRight" onClick={() => setView('scenarios')}>
              Open Scenario Builder
            </Button>
          }
        />
      </Panel>
    );
  }

  return (
    <div className="space-y-4">
      <ChaosBanner chaos={frame.activeChaos} />

      <HeroStrip frame={frame} run={run} />

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Panel title="Throughput · latency · errors" icon="gauge">
            <div className="grid gap-5 md:grid-cols-2">
              <RpsChart points={points} />
              <LatencyChart points={points} />
              <ErrorRateChart points={points} />
              <EventMixDonut byCategory={frame.eventMix.byCategory} />
            </div>
          </Panel>
        </div>

        <div className="h-[560px]">
          <EventTicker events={ticker} />
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ReceiverPanel receiver={frame.receiver} />
        <DeliveryPanel delivery={frame.delivery} />
      </div>
    </div>
  );
}
