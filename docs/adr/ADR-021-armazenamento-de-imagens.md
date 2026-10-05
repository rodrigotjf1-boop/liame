# ADR-021 — Onde ficam as fotos dos produtos e as imagens das peças

- **Status:** Proposto · 05/10/2026 (espera a aprovação do dono)
- **Decide:** onde o Liame guarda arquivos de imagem (a foto do produto que a empresa envia e a imagem que o Criativo gera), como eles entram, quem os lê e quando saem
- **Base:** base de conhecimento §17.6 · ADR-011 (a conta AWS já em uso) · ADR-014 (ciclo de vida) · ADR-016 (imagem por finalidade) · `plano-a4.md` X5 e X7, D-A4-9 e D-A4-28

## Contexto

Até a X6 o Liame não guarda arquivo nenhum: tudo é linha no Postgres. A imagem do Criativo (X7) e a campanha nova (X5) mudam isso:

- a imagem de uma peça parte de **uma foto de verdade do produto, enviada pela empresa** (D-A4-28), e a peça só de texto usa a foto como ela é;
- a imagem gerada precisa ficar guardada para a pessoa ver e decidir;
- a imagem aprovada vai para a Meta em bytes (`POST /act_{id}/adimages`, base de conhecimento §2.1).

O que o lugar precisa ter:

1. **Ficar no Brasil**, como o banco. A Política diz onde cada fornecedor guarda os dados; um arquivo fora do país vira transferência internacional.
2. **Ser privado.** Nenhuma URL pública: toda leitura passa pela permissão e pela empresa de quem pede.
3. **Não criar fornecedor nem segredo novo**, se der.
4. **Apagar de verdade** no expurgo (ADR-014), inclusive a empresa inteira no fim do contrato.
5. **Custar pouco e não prender o Liame**: protocolo padrão, que outro fornecedor também fale.

Volume esperado: imagens de 1 a 5 MB. Uma marca com 50 fotos de produto e 100 peças por mês guarda perto de 1 GB por mês antes do expurgo.

## Opções

Fatos conferidos nas páginas oficiais em 05/10/2026 (base de conhecimento §17.6); o preço do S3 em São Paulo vem de fonte secundária, porque a página oficial carrega os valores na hora.

| Opção | Onde o arquivo fica | Acesso | Custo | Veredito |
| --- | --- | --- | --- | --- |
| **AWS S3 em São Paulo**, na conta que já tem o KMS e o SES | Brasil | permissão por bucket e por ação; URL assinada com prazo; cifra em repouso por padrão, sem custo | cerca de US$ 0,04 por GB por mês | **Escolhido** |
| Supabase Storage, no projeto do banco | Brasil | protocolo S3; a chave do servidor abre todos os buckets e passa por cima da RLS | 1 GB no plano gratuito, 100 GB no Pro; depois US$ 0,0213 por GB | Alternativa |
| Cloudflare R2 | fora do Brasil: não há região nem jurisdição na América do Sul | protocolo S3 | US$ 0,015 por GB por mês, saída grátis | **Rejeitado:** tira o arquivo do país |
| Disco da VPS | Brasil | arquivo local | nenhum | **Rejeitado:** some com o contêiner, não tem cópia e não serve a dois servidores |
| Postgres (coluna binária) | Brasil | SQL | o do banco | **Rejeitado:** incha o banco e o backup |

Por que o S3 e não o Supabase Storage, que também fica em São Paulo:

- **Privilégio mínimo.** No S3, o usuário do servidor recebe só gravar, ler e apagar num bucket. No Supabase, as chaves S3 "provide full access to all S3 operations across all buckets and bypass RLS policies".
- **Nenhum fornecedor novo e nenhum segredo novo.** A AWS já está em uso (chaves de criptografia e e-mails), com a credencial do usuário `liame-sistema` no EasyPanel. Só a permissão dele cresce.
- **Cópia e volta.** No Supabase, "Database backups do not include objects you store via the Storage API", e "Deleted objects are permanently removed and cannot be restored". No S3 dá para ligar versões e regras de ciclo de vida quando for preciso.
- **O arquivo não anda junto com o banco.** Trocar o banco de lugar não obriga a mover as imagens.

O preço do S3 é o custo de quem escolhe: o dono cria o bucket e amplia a permissão do usuário (eu guio, um print por vez), e a conta paga centavos por mês.

## Decisão (proposta)

1. **Um bucket privado no S3, em São Paulo**, na conta AWS do Liame. Acesso público bloqueado, cifra em repouso padrão (AES-256) e uma regra no bucket que recusa URL assinada com mais de 10 minutos e pedido sem TLS.
2. **Só o servidor fala com o S3.** O navegador nunca recebe credencial.
   - **Enviar:** o arquivo vai para a API do Liame, que confere e só então grava. Não há envio direto do navegador para o bucket: o que não foi conferido não é guardado.
   - **Ver:** a API confere a permissão e a empresa e devolve uma URL assinada de leitura que vale 5 minutos. A URL assinada é uma chave ao portador: por isso o prazo curto e o teto de 10 minutos no bucket.
3. **Nada entra sem conferência.**
   - O tipo é lido do conteúdo, nunca da extensão nem do cabeçalho: JPEG, PNG ou WebP. SVG e GIF não entram.
   - Até 10 MB por arquivo; lado menor de pelo menos 600 pixels (o mínimo que o guia da Meta pede no Feed); lado maior de até 8.000 pixels.
   - A imagem é **regravada pelo servidor** (decodificada e codificada de novo). Isso tira os metadados (a foto do celular traz a localização) e qualquer coisa que não seja imagem.
4. **O banco guarda o registro; o S3, os bytes.** Uma tabela nova, com RLS como as outras: empresa, marca, tipo (`foto_produto` ou `imagem_de_peca`), chave do objeto, hash, tamanho, largura, altura, formato, origem (`envio` ou `ia`), quem enviou e quando. O nome original do arquivo não é guardado.
5. **A chave do objeto começa pela empresa e pela marca** (`t/{empresa}/b/{marca}/{tipo}/{id}`): apagar uma empresa é apagar um prefixo.
6. **Expurgo (ADR-014).** O objeto sai primeiro, a linha depois, com nova tentativa se o S3 falhar.
   - Foto de produto: fica enquanto a marca existir, ou até a pessoa apagar.
   - Imagem de peça recusada: 30 dias.
   - Imagem de peça aprovada: como o criativo arquivado, 12 meses depois de arquivada.
   - Fim do contrato: o prefixo inteiro da empresa, no mesmo passo em que a organização é apagada.
7. **Local e teste.** No desenvolvimento, um adaptador de disco (pasta fora do git); nos testes, um de memória; em produção, o S3. Sem o bucket configurado, a função de imagem fica indisponível e o resto do produto não muda.
8. **O que sai do Liame.** A foto e o pedido da peça vão ao fornecedor de imagem (X7), e a imagem aprovada vai à Meta (X5), sempre pelo servidor, em bytes. Nenhum terceiro recebe endereço do bucket.

## Consequências

- **Dependências novas no servidor:** o cliente do S3 e o assinador de URL, do mesmo SDK da AWS já usado para o KMS e o SES, e uma biblioteca de processamento de imagem com binário nativo (conferir no build da imagem do contêiner).
- **Configuração nova:** o nome do bucket. A credencial é a que já existe.
- **Jurídico, no PR do código:** a Política passa a dizer que a AWS guarda também as imagens enviadas pela empresa e as geradas (o país continua sendo o Brasil), com os prazos acima na seção 9; os Termos passam a dizer que a empresa responde pelo que envia (direito de usar a foto, sem pessoa identificável).
- **Custo:** cerca de US$ 0,04 por GB por mês. Dez gigabytes custam perto de US$ 0,40 por mês; pedidos e tráfego são desprezíveis neste volume.
- **Rever** quando o volume passar de centenas de gigabytes (classe de armazenamento mais barata para o que é antigo) ou quando houver vídeo, que é outra ordem de tamanho.

## O que o dono decide

1. **Aprovar o S3 em São Paulo** (ou preferir o Supabase Storage, sabendo da chave que abre todos os buckets).
2. **Os limites:** 10 MB por foto e 30 dias para a imagem de peça recusada.

Depois da aprovação, os passos dele são dois, no console da AWS, guiados um print por vez: criar o bucket e ampliar a permissão do usuário `liame-sistema`.
