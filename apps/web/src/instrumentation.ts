// Hook de instrumentação do Next 16: o OTel só no runtime Node (ADR-010, base §15).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startTelemetry } = await import('@liame/telemetry');
    startTelemetry({ serviceName: 'liame-web' });
  }
}
