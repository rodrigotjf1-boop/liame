import { mkdir, open, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';

// O armazenamento de imagens (ADR-021): o S3 em São Paulo, privado, em produção; um disco (pasta fora do git) no
// desenvolvimento; a memória nos testes. Só o servidor fala com ele: o navegador recebe um endereço assinado que vale
// poucos minutos (o bucket recusa assinatura com mais de 10). Sem o bucket configurado, a função de imagem fica
// indisponível e o resto do produto não muda (item 7).

export const ARMAZEM_DE_IMAGENS = Symbol('ARMAZEM_DE_IMAGENS');

export interface ArmazemDeImagens {
  /** `false` em produção sem o bucket configurado: a função de imagem fica indisponível. */
  readonly disponivel: boolean;
  readonly tipo: 's3' | 'disco' | 'memoria' | 'indisponivel';
  /** Grava a imagem (sempre JPEG) na chave. */
  gravar(chave: string, bytes: Buffer): Promise<void>;
  /** Apaga as chaves; a que já não existe não é erro. */
  apagar(chaves: readonly string[]): Promise<void>;
  /** Apaga tudo o que começa pelo prefixo (a marca ou a empresa inteira) e diz quantos objetos saíram. */
  apagarPrefixo(prefixo: string): Promise<number>;
  /**
   * O endereço de leitura da imagem, que vale `segundos`. Com `baixarComo` (um nome `.jpg` do Liame), o endereço baixa a
   * imagem como arquivo com esse nome, em vez de abri-la (o pacote pronto, D-A6-43).
   */
  enderecoDeLeitura(chave: string, segundos: number, baixarComo?: string): Promise<string>;
  /** Os bytes da imagem guardada (o recorte do post do Instagram sai da cópia da foto). */
  ler(chave: string): Promise<Buffer>;
  /**
   * O endereço de ENVIO direto do vídeo (A6 · Z10): o navegador manda o arquivo ao armazenamento, sem passar pelo
   * servidor do Liame, com o `tipo` (Content-Type) e o tamanho (`bytes`, o Content-Length) que vão na assinatura: o
   * armazenamento recusa outro tipo ou outro tamanho. Vale `segundos`. Nulo onde o envio direto não existe (o disco do
   * desenvolvimento, ou o S3 sem o assinador do envio); nos testes, a memória devolve um endereço de mentira.
   */
  enderecoDeEnvio(chave: string, tipo: string, bytes: number, segundos: number): Promise<string | null>;
  /** O tamanho do objeto em bytes; nulo quando ele não existe (o envio que não chegou). */
  tamanho(chave: string): Promise<number | null>;
  /** Os bytes de `inicio` a `fim` (inclusive) do objeto: a leitura do cabeçalho do vídeo, aos pedaços. */
  lerTrecho(chave: string, inicio: number, fim: number): Promise<Buffer>;
}

/** O maior trecho que o servidor lê de uma vez (o cabeçalho do vídeo de 90 s cabe com folga). */
export const MAIOR_TRECHO_BYTES = 8 * 1024 * 1024;

function exigirTrecho(inicio: number, fim: number): void {
  if (!Number.isSafeInteger(inicio) || !Number.isSafeInteger(fim) || inicio < 0 || fim < inicio || fim - inicio + 1 > MAIOR_TRECHO_BYTES) {
    throw new Error('armazenamento de imagens: trecho fora do desenho');
  }
}

/** A função de imagem está indisponível (produção sem o bucket). */
export class ArmazemIndisponivel extends Error {
  constructor() {
    super('armazenamento de imagens indisponível: defina IMAGENS_BUCKET (ADR-021)');
  }
}

/**
 * O armazenamento recusou ou falhou (rede, permissão). A mensagem não leva credencial nem endereço assinado.
 * `semArquivo`: a chave não tem imagem (apagada, ou nunca gravada): tentar de novo não resolve.
 */
export class FalhaDoArmazem extends Error {
  constructor(
    mensagem: string,
    readonly semArquivo = false,
  ) {
    super(mensagem);
  }
}

/** O nome do arquivo que o endereço baixa: só minúsculas, números e hífen, terminado em `.jpg` (nada que quebre o cabeçalho). */
const NOME_DE_ARQUIVO = /^[a-z0-9-]{1,80}\.jpg$/;

function exigirNome(nome: string | undefined): void {
  if (nome !== undefined && !NOME_DE_ARQUIVO.test(nome)) throw new Error('armazenamento de imagens: nome de arquivo fora do desenho');
}

/** A maior imagem que o servidor lê do armazenamento: a cópia guardada tem o lado maior em até 2.048 px (ADR-021). */
export const MAIOR_LEITURA_BYTES = 20 * 1024 * 1024;

// As chaves que o Liame grava e os prefixos que apaga. A foto das Fotos (`t/{empresa}/b/{marca}/foto_produto/{id}.jpg`)
// e a miniatura dela; o vídeo das Fotos (`t/{empresa}/b/{marca}/video/{id}.mp4` ou `.mov`, A6 · Z10) e a capa dele
// (`{id}-mini.jpg`); o recorte do post do Instagram (`t/{empresa}/b/{marca}/post/{post}-instagram.jpg`, A6 · Z5b); o
// logo da agência (`t/{agência}/agencia/logo/{id}.jpg`, A7 · W7, parte 3). Conferidas parte por parte antes de qualquer
// gravação, leitura ou apagamento: nada fora do desenho chega ao disco ou ao bucket.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function ehUuid(s: string): boolean {
  return UUID.test(s);
}

/** O nome do arquivo sem o final (`-mini.jpg`, `.jpg`); vazio quando não termina por nenhum dos aceitos. */
function semFinal(arquivo: string, finais: readonly string[]): string {
  for (const f of finais) if (arquivo.endsWith(f)) return arquivo.slice(0, -f.length);
  return '';
}

function chaveValida(chave: string): boolean {
  const p = chave.split('/');
  if (chave.length > 300 || p[0] !== 't') return false;
  if (p.length === 5) return p[2] === 'agencia' && p[3] === 'logo' && ehUuid(p[1] ?? '') && ehUuid(semFinal(p[4] ?? '', ['.jpg']));
  if (p.length !== 6 || p[2] !== 'b') return false;
  const arquivo = p[5] ?? '';
  const id =
    p[4] === 'foto_produto'
      ? semFinal(arquivo, ['-mini.jpg', '.jpg'])
      : p[4] === 'video'
        ? semFinal(arquivo, ['-mini.jpg', '.mp4', '.mov'])
        : p[4] === 'post'
          ? semFinal(arquivo, ['-instagram.jpg'])
          : '';
  return ehUuid(p[1] ?? '') && ehUuid(p[3] ?? '') && ehUuid(id);
}

/** `t/{empresa}/` ou `t/{empresa}/b/{marca}/`. */
function prefixoValido(prefixo: string): boolean {
  const p = prefixo.split('/');
  if (prefixo.length > 120 || p[0] !== 't' || p[p.length - 1] !== '') return false;
  if (p.length === 3) return ehUuid(p[1] ?? '');
  return p.length === 5 && ehUuid(p[1] ?? '') && p[2] === 'b' && ehUuid(p[3] ?? '');
}

function exigirChave(chave: string): void {
  if (!chaveValida(chave)) throw new Error('armazenamento de imagens: chave fora do formato');
}

function exigirPrefixo(prefixo: string): void {
  if (!prefixoValido(prefixo)) throw new Error('armazenamento de imagens: prefixo fora do formato');
}

/** Nos testes: tudo na memória, com falha simulada para provar o caminho de nova tentativa. */
export class ArmazemNaMemoria implements ArmazemDeImagens {
  readonly disponivel = true;
  readonly tipo = 'memoria';
  readonly objetos = new Map<string, Buffer>();
  /** O que falha de propósito, para os testes. */
  falhar: { gravar?: boolean; apagar?: boolean; ler?: boolean } = {};

  async gravar(chave: string, bytes: Buffer): Promise<void> {
    exigirChave(chave);
    if (this.falhar.gravar) throw new FalhaDoArmazem('memória: falha simulada ao gravar');
    this.objetos.set(chave, Buffer.from(bytes));
  }

  async ler(chave: string): Promise<Buffer> {
    exigirChave(chave);
    if (this.falhar.ler) throw new FalhaDoArmazem('memória: falha simulada ao ler');
    const bytes = this.objetos.get(chave);
    if (!bytes) throw new FalhaDoArmazem('memória: a chave não tem imagem', true);
    return Buffer.from(bytes);
  }

  async apagar(chaves: readonly string[]): Promise<void> {
    for (const c of chaves) exigirChave(c);
    if (this.falhar.apagar) throw new FalhaDoArmazem('memória: falha simulada ao apagar');
    for (const c of chaves) this.objetos.delete(c);
  }

  async apagarPrefixo(prefixo: string): Promise<number> {
    exigirPrefixo(prefixo);
    if (this.falhar.apagar) throw new FalhaDoArmazem('memória: falha simulada ao apagar');
    let n = 0;
    for (const c of [...this.objetos.keys()]) {
      if (c.startsWith(prefixo)) {
        this.objetos.delete(c);
        n += 1;
      }
    }
    return n;
  }

  async enderecoDeLeitura(chave: string, segundos: number, baixarComo?: string): Promise<string> {
    exigirChave(chave);
    exigirNome(baixarComo);
    return `memoria://imagens/${chave}?valido=${segundos}${baixarComo ? `&baixar=${baixarComo}` : ''}`;
  }

  /** Nos testes, o envio é de mentira: quem testa grava o arquivo com `chegou` (como o navegador faria). */
  async enderecoDeEnvio(chave: string, tipo: string, bytes: number, segundos: number): Promise<string | null> {
    exigirChave(chave);
    return `memoria://envio/${chave}?tipo=${encodeURIComponent(tipo)}&bytes=${bytes}&valido=${segundos}`;
  }

  /** O arquivo que o navegador mandou pelo endereço de envio (nos testes). */
  chegou(chave: string, bytes: Buffer): void {
    exigirChave(chave);
    this.objetos.set(chave, Buffer.from(bytes));
  }

  async tamanho(chave: string): Promise<number | null> {
    exigirChave(chave);
    if (this.falhar.ler) throw new FalhaDoArmazem('memória: falha simulada ao ler');
    return this.objetos.get(chave)?.length ?? null;
  }

  async lerTrecho(chave: string, inicio: number, fim: number): Promise<Buffer> {
    exigirChave(chave);
    exigirTrecho(inicio, fim);
    if (this.falhar.ler) throw new FalhaDoArmazem('memória: falha simulada ao ler');
    const bytes = this.objetos.get(chave);
    if (!bytes) throw new FalhaDoArmazem('memória: a chave não tem arquivo', true);
    return Buffer.from(bytes.subarray(inicio, fim + 1));
  }
}

/** No desenvolvimento: uma pasta fora do git. O endereço de leitura é a própria imagem (`data:`), sem rota nova. */
export class ArmazemNoDisco implements ArmazemDeImagens {
  readonly disponivel = true;
  readonly tipo = 'disco';

  constructor(private readonly pasta: string) {}

  private caminho(chave: string): string {
    const p = resolve(this.pasta, ...chave.split('/'));
    if (!p.startsWith(resolve(this.pasta) + sep)) throw new Error('armazenamento de imagens: caminho fora da pasta');
    return p;
  }

  async gravar(chave: string, bytes: Buffer): Promise<void> {
    exigirChave(chave);
    const p = this.caminho(chave);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }

  async apagar(chaves: readonly string[]): Promise<void> {
    for (const c of chaves) exigirChave(c);
    for (const c of chaves) await unlink(this.caminho(c)).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? undefined : Promise.reject(e)));
  }

  async apagarPrefixo(prefixo: string): Promise<number> {
    exigirPrefixo(prefixo);
    const pasta = resolve(this.pasta, ...prefixo.split('/').filter(Boolean));
    const arquivos = await readdir(pasta, { recursive: true, withFileTypes: true }).catch(() => []);
    const n = arquivos.filter((a) => a.isFile()).length;
    await rm(pasta, { recursive: true, force: true });
    return n;
  }

  async enderecoDeLeitura(chave: string, _segundos: number, baixarComo?: string): Promise<string> {
    exigirChave(chave);
    exigirNome(baixarComo);
    // `data:` não leva o nome do arquivo: a tela dá o nome no link (só no desenvolvimento).
    return `data:image/jpeg;base64,${(await readFile(this.caminho(chave))).toString('base64')}`;
  }

  async ler(chave: string): Promise<Buffer> {
    exigirChave(chave);
    try {
      return await readFile(this.caminho(chave));
    } catch (e) {
      const codigo = (e as NodeJS.ErrnoException).code;
      throw new FalhaDoArmazem(`disco: ${codigo ?? 'erro'}`, codigo === 'ENOENT');
    }
  }

  /** No desenvolvimento não há envio direto: o vídeo precisa do bucket. */
  async enderecoDeEnvio(chave: string): Promise<string | null> {
    exigirChave(chave);
    return null;
  }

  async tamanho(chave: string): Promise<number | null> {
    exigirChave(chave);
    try {
      return (await stat(this.caminho(chave))).size;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new FalhaDoArmazem(`disco: ${(e as NodeJS.ErrnoException).code ?? 'erro'}`);
    }
  }

  async lerTrecho(chave: string, inicio: number, fim: number): Promise<Buffer> {
    exigirChave(chave);
    exigirTrecho(inicio, fim);
    let arquivo;
    try {
      arquivo = await open(this.caminho(chave), 'r');
    } catch (e) {
      const codigo = (e as NodeJS.ErrnoException).code;
      throw new FalhaDoArmazem(`disco: ${codigo ?? 'erro'}`, codigo === 'ENOENT');
    }
    try {
      const destino = Buffer.alloc(fim - inicio + 1);
      const { bytesRead } = await arquivo.read(destino, 0, destino.length, inicio);
      return destino.subarray(0, bytesRead);
    } finally {
      await arquivo.close();
    }
  }
}

/** Em produção sem o bucket: indisponível. */
export class ArmazemFechado implements ArmazemDeImagens {
  readonly disponivel = false;
  readonly tipo = 'indisponivel';
  gravar(): Promise<void> {
    return Promise.reject(new ArmazemIndisponivel());
  }
  apagar(): Promise<void> {
    return Promise.reject(new ArmazemIndisponivel());
  }
  apagarPrefixo(): Promise<number> {
    return Promise.reject(new ArmazemIndisponivel());
  }
  enderecoDeLeitura(): Promise<string> {
    return Promise.reject(new ArmazemIndisponivel());
  }
  ler(): Promise<Buffer> {
    return Promise.reject(new ArmazemIndisponivel());
  }
  enderecoDeEnvio(): Promise<string | null> {
    return Promise.reject(new ArmazemIndisponivel());
  }
  tamanho(): Promise<number | null> {
    return Promise.reject(new ArmazemIndisponivel());
  }
  lerTrecho(): Promise<Buffer> {
    return Promise.reject(new ArmazemIndisponivel());
  }
}

/** O que o adaptador do S3 usa do SDK: os comandos, o cliente e o assinador (trocáveis nos testes). */
export interface SdkDoS3 {
  PutObjectCommand: new (input: { Bucket: string; Key: string; Body?: Buffer; ContentType: string; CacheControl?: string; ContentLength?: number }) => unknown;
  DeleteObjectsCommand: new (input: { Bucket: string; Delete: { Objects: Array<{ Key: string }>; Quiet: boolean } }) => unknown;
  ListObjectsV2Command: new (input: { Bucket: string; Prefix: string; ContinuationToken?: string; MaxKeys: number }) => unknown;
  GetObjectCommand: new (input: { Bucket: string; Key: string; ResponseContentDisposition?: string; Range?: string }) => unknown;
  HeadObjectCommand: new (input: { Bucket: string; Key: string }) => unknown;
}
export interface ClienteDoS3 {
  send(comando: unknown): Promise<unknown>;
}
export type AssinadorDoS3 = (cliente: ClienteDoS3, comando: unknown, segundos: number) => Promise<string>;

/**
 * Assina o envio direto (PUT) do navegador ao bucket (A6 · Z10). Usa um cliente próprio, que só calcula o checksum
 * do corpo quando a operação exige: o cliente padrão do SDK põe na URL o CRC32 do corpo VAZIO (o do momento da
 * assinatura), e o S3 recusaria o vídeo que chega. E assina o `content-type` (o SDK só assina o `host` e o
 * `content-length`): o arquivo de outro tipo não entra.
 */
export type AssinadorDoEnvio = (comando: unknown, segundos: number) => Promise<string>;

/** O nome do erro do SDK, sem a mensagem inteira (que pode trazer o endereço do pedido). */
function nomeDoErro(e: unknown): string {
  if (e && typeof e === 'object') {
    const x = e as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown } };
    const nome = typeof x.name === 'string' ? x.name : typeof x.Code === 'string' ? x.Code : 'erro';
    const status = typeof x.$metadata?.httpStatusCode === 'number' ? ` (${x.$metadata.httpStatusCode})` : '';
    return `${nome}${status}`;
  }
  return 'erro';
}

/** Em produção: o bucket privado em São Paulo, com a credencial do usuário `liame-sistema` (a do KMS e do SES). */
export class ArmazemS3 implements ArmazemDeImagens {
  readonly disponivel = true;
  readonly tipo = 's3';

  constructor(
    private readonly sdk: SdkDoS3,
    private readonly cliente: ClienteDoS3,
    private readonly assinar: AssinadorDoS3,
    private readonly bucket: string,
    /** Sem ele, não há envio direto (`enderecoDeEnvio` devolve nulo): nunca um endereço que o S3 recusaria. */
    private readonly assinarEnvio: AssinadorDoEnvio | null = null,
  ) {}

  /**
   * O de produção. `credenciais` só nos testes (a assinatura sem rede); em produção, as do ambiente (o usuário
   * `liame-sistema`). `endereco`: um S3 local, só no desenvolvimento (o roteiro de navegador do vídeo; `criarArmazem`
   * recusa em produção), com o bucket no caminho.
   */
  static async criar(
    regiao: string,
    bucket: string,
    credenciais?: { accessKeyId: string; secretAccessKey: string },
    endereco?: string,
  ): Promise<ArmazemS3> {
    const s3 = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const comum = { region: regiao, ...(credenciais ? { credentials: credenciais } : {}), ...(endereco ? { endpoint: endereco, forcePathStyle: true } : {}) };
    const cliente = new s3.S3Client(comum);
    const assinar: AssinadorDoS3 = (c, comando, segundos) => getSignedUrl(c as never, comando as never, { expiresIn: segundos });
    const clienteDoEnvio = new s3.S3Client({ ...comum, requestChecksumCalculation: 'WHEN_REQUIRED' });
    const assinarEnvio: AssinadorDoEnvio = (comando, segundos) =>
      getSignedUrl(clienteDoEnvio, comando as never, { expiresIn: segundos, signableHeaders: new Set(['content-type']) });
    return new ArmazemS3(s3 as unknown as SdkDoS3, cliente, assinar, bucket, assinarEnvio);
  }

  private async enviar(comando: unknown): Promise<unknown> {
    try {
      return await this.cliente.send(comando);
    } catch (e) {
      throw new FalhaDoArmazem(`S3: ${nomeDoErro(e)}`);
    }
  }

  async gravar(chave: string, bytes: Buffer): Promise<void> {
    exigirChave(chave);
    await this.enviar(new this.sdk.PutObjectCommand({ Bucket: this.bucket, Key: chave, Body: bytes, ContentType: 'image/jpeg', CacheControl: 'private, max-age=300' }));
  }

  async apagar(chaves: readonly string[]): Promise<void> {
    for (const c of chaves) exigirChave(c);
    await this.apagarEmLotes(chaves);
  }

  private async apagarEmLotes(chaves: readonly string[]): Promise<void> {
    for (let i = 0; i < chaves.length; i += 1000) {
      const lote = chaves.slice(i, i + 1000);
      const r = (await this.enviar(
        new this.sdk.DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: lote.map((Key) => ({ Key })), Quiet: true } }),
      )) as { Errors?: Array<{ Code?: string }> } | undefined;
      const erros = r?.Errors ?? [];
      if (erros.length) throw new FalhaDoArmazem(`S3: ${erros.length} objeto(s) não apagado(s) (${erros[0]?.Code ?? 'erro'})`);
    }
  }

  async apagarPrefixo(prefixo: string): Promise<number> {
    exigirPrefixo(prefixo);
    let continuacao: string | undefined;
    let n = 0;
    do {
      const r = (await this.enviar(
        new this.sdk.ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefixo, ContinuationToken: continuacao, MaxKeys: 1000 }),
      )) as { Contents?: Array<{ Key?: string }>; IsTruncated?: boolean; NextContinuationToken?: string } | undefined;
      const chaves = (r?.Contents ?? []).map((c) => c.Key).filter((k): k is string => typeof k === 'string' && k.startsWith(prefixo));
      if (chaves.length) await this.apagarEmLotes(chaves);
      n += chaves.length;
      continuacao = r?.IsTruncated ? r.NextContinuationToken : undefined;
    } while (continuacao);
    return n;
  }

  async enderecoDeLeitura(chave: string, segundos: number, baixarComo?: string): Promise<string> {
    exigirChave(chave);
    exigirNome(baixarComo);
    // Com o nome, o S3 responde com `Content-Disposition: attachment` (vai na assinatura): o navegador baixa o arquivo.
    const comando = new this.sdk.GetObjectCommand({ Bucket: this.bucket, Key: chave, ...(baixarComo ? { ResponseContentDisposition: `attachment; filename="${baixarComo}"` } : {}) });
    try {
      return await this.assinar(this.cliente, comando, segundos);
    } catch (e) {
      throw new FalhaDoArmazem(`S3: ${nomeDoErro(e)}`);
    }
  }

  async ler(chave: string): Promise<Buffer> {
    exigirChave(chave);
    let r: { Body?: { transformToByteArray?: () => Promise<Uint8Array> }; ContentLength?: number } | undefined;
    try {
      r = (await this.cliente.send(new this.sdk.GetObjectCommand({ Bucket: this.bucket, Key: chave }))) as typeof r;
    } catch (e) {
      const nome = nomeDoErro(e);
      throw new FalhaDoArmazem(`S3: ${nome}`, nome.startsWith('NoSuchKey'));
    }
    if (typeof r?.ContentLength === 'number' && r.ContentLength > MAIOR_LEITURA_BYTES) throw new FalhaDoArmazem('S3: a imagem passa do tamanho que o servidor lê');
    const corpo = r?.Body;
    if (!corpo?.transformToByteArray) throw new FalhaDoArmazem('S3: a resposta veio sem a imagem');
    let bytes: Uint8Array;
    try {
      bytes = await corpo.transformToByteArray();
    } catch (e) {
      throw new FalhaDoArmazem(`S3: ${nomeDoErro(e)}`);
    }
    if (bytes.byteLength > MAIOR_LEITURA_BYTES) throw new FalhaDoArmazem('S3: a imagem passa do tamanho que o servidor lê');
    return Buffer.from(bytes);
  }

  /**
   * O envio direto do vídeo (A6 · Z10): um PUT assinado, com o Content-Type e o Content-Length na assinatura (o
   * navegador manda os mesmos), pelo assinador do envio (sem o checksum do corpo vazio, ERR-203). O bucket aceita o envio do app pela regra de CORS dele (configuração do bucket, fora do código).
   */
  async enderecoDeEnvio(chave: string, tipo: string, bytes: number, segundos: number): Promise<string | null> {
    exigirChave(chave);
    if (!this.assinarEnvio) return null;
    if (!Number.isInteger(bytes) || bytes < 1) throw new Error('armazenamento de imagens: tamanho fora do desenho');
    // O tipo e o tamanho entram na assinatura: o navegador manda o arquivo com os dois exatamente assim.
    const comando = new this.sdk.PutObjectCommand({ Bucket: this.bucket, Key: chave, ContentType: tipo, ContentLength: bytes });
    try {
      return await this.assinarEnvio(comando, segundos);
    } catch (e) {
      throw new FalhaDoArmazem(`S3: ${nomeDoErro(e)}`);
    }
  }

  async tamanho(chave: string): Promise<number | null> {
    exigirChave(chave);
    let r: { ContentLength?: number } | undefined;
    try {
      r = (await this.cliente.send(new this.sdk.HeadObjectCommand({ Bucket: this.bucket, Key: chave }))) as typeof r;
    } catch (e) {
      const nome = nomeDoErro(e);
      // O HEAD do objeto que não existe volta sem corpo: o SDK diz `NotFound` (404).
      if (nome.startsWith('NotFound') || nome.startsWith('NoSuchKey') || nome.endsWith('(404)')) return null;
      throw new FalhaDoArmazem(`S3: ${nome}`);
    }
    return typeof r?.ContentLength === 'number' ? r.ContentLength : null;
  }

  async lerTrecho(chave: string, inicio: number, fim: number): Promise<Buffer> {
    exigirChave(chave);
    exigirTrecho(inicio, fim);
    let r: { Body?: { transformToByteArray?: () => Promise<Uint8Array> } } | undefined;
    try {
      r = (await this.cliente.send(new this.sdk.GetObjectCommand({ Bucket: this.bucket, Key: chave, Range: `bytes=${inicio}-${fim}` }))) as typeof r;
    } catch (e) {
      const nome = nomeDoErro(e);
      throw new FalhaDoArmazem(`S3: ${nome}`, nome.startsWith('NoSuchKey'));
    }
    const corpo = r?.Body;
    if (!corpo?.transformToByteArray) throw new FalhaDoArmazem('S3: a resposta veio sem o trecho');
    let bytes: Uint8Array;
    try {
      bytes = await corpo.transformToByteArray();
    } catch (e) {
      throw new FalhaDoArmazem(`S3: ${nomeDoErro(e)}`);
    }
    if (bytes.byteLength > MAIOR_TRECHO_BYTES) throw new FalhaDoArmazem('S3: o trecho passa do que o servidor lê');
    return Buffer.from(bytes);
  }
}

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Onde ficam as imagens: `s3` (produção), `disco` (desenvolvimento) ou `memoria` (testes). */
  IMAGENS_ARMAZEM: z.enum(['s3', 'disco', 'memoria']).optional(),
  /** O bucket privado do S3 (o nome tem o número da conta: fica só no ambiente, nunca no repositório). */
  IMAGENS_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/).optional(),
  /** A pasta do disco no desenvolvimento (fora do git). */
  IMAGENS_PASTA_LOCAL: z.string().min(1).optional(),
  /**
   * Um S3 local (o imitador do roteiro de navegador do vídeo, A6 · Z10), só no desenvolvimento: o vídeo vai do
   * navegador direto ao armazenamento, e o disco não recebe esse envio. Em produção, o servidor não sobe com ele.
   */
  IMAGENS_S3_ENDPOINT: z
    .string()
    .regex(/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/)
    .optional(),
  AWS_REGION: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/).default('sa-east-1'),
});

/** Monta o armazenamento a partir do ambiente. Em produção, só o S3 (ou indisponível, sem o bucket). */
export async function criarArmazem(source: NodeJS.ProcessEnv = process.env): Promise<ArmazemDeImagens> {
  const env = Env.parse(source);
  if (env.IMAGENS_S3_ENDPOINT && env.NODE_ENV === 'production') throw new Error('config: em produção, IMAGENS_S3_ENDPOINT não vale (o S3 local é do desenvolvimento)');
  const tipo = env.IMAGENS_ARMAZEM ?? (env.NODE_ENV === 'production' ? 's3' : env.NODE_ENV === 'test' ? 'memoria' : 'disco');
  if (tipo === 's3') return env.IMAGENS_BUCKET ? ArmazemS3.criar(env.AWS_REGION, env.IMAGENS_BUCKET, undefined, env.IMAGENS_S3_ENDPOINT) : new ArmazemFechado();
  if (env.NODE_ENV === 'production') throw new Error('config: em produção, IMAGENS_ARMAZEM só pode ser s3 (ADR-021)');
  if (tipo === 'disco') return new ArmazemNoDisco(resolve(env.IMAGENS_PASTA_LOCAL ?? join(process.cwd(), '.liame-imagens-locais')));
  return new ArmazemNaMemoria();
}
