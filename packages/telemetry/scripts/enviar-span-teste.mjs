// Manda um span com dado pessoal de propósito para um Collector local (sem a redação da app),
// para conferir a redação do próprio Collector: `node scripts/enviar-span-teste.mjs http://127.0.0.1:14318`.
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

const endpoint = `${process.argv[2] ?? 'http://127.0.0.1:4318'}/v1/traces`;
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new OTLPTraceExporter({ url: endpoint }))] });
const tracer = provider.getTracer('teste-coletor');
const span = tracer.startSpan('acao.executar', {
  attributes: {
    'liame.action_id': 'acao-teste',
    'user_agent.original': 'teste +55 21 99876-5432',
    'contato': 'fulano.teste@exemplo.com.br',
    'documento': '123.456.789-09',
    'client.address': '189.40.12.201',
    'http.request.header.cookie': 'liame_sessao=segredo',
  },
});
span.end();
await provider.forceFlush();
await provider.shutdown();
console.log(`span enviado para ${endpoint}`);
