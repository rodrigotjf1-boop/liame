import { HealthResponse } from '@liame/contracts';

// Página provisória da fundação (A0). As telas do produto chegam na A1, portadas do protótipo aprovado.
const web = HealthResponse.parse({ status: 'ok', service: 'liame-web', version: 'dev' });

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col justify-center gap-6 px-4 py-16 sm:px-6">
      <p className="font-mono text-xs tracking-[0.14em] text-text-subtle uppercase">Fundação técnica · A0</p>
      <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">Liame</h1>
      <p className="max-w-prose text-base text-text-muted">
        Sua agência de marketing com funcionários de IA está sendo montada. Esta página só confirma que a base do
        webapp está de pé.
      </p>
      <dl className="grid w-full grid-cols-1 gap-3 rounded-2xl border border-border bg-surface p-4 sm:grid-cols-2">
        <div>
          <dt className="font-mono text-xs text-text-subtle uppercase">Serviço</dt>
          <dd className="font-mono text-sm">{web.service}</dd>
        </div>
        <div>
          <dt className="font-mono text-xs text-text-subtle uppercase">Estado</dt>
          <dd className="font-mono text-sm text-success">{web.status}</dd>
        </div>
      </dl>
    </main>
  );
}
