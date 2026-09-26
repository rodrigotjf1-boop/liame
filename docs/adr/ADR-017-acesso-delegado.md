# ADR-017 — Acesso delegado: o dono convida por e-mail quem administra por ele

- **Status:** Aceito · 26/09/2026 (proposto em 25/09/2026; aprovado com o plano completo pelo dono)
- **Base:** base de conhecimento §17.5 · ADR-013 (acesso) · ADR-003 (tenant) · `security-model.md` §3

## Contexto

Pedido do dono (25/09/2026): quem contrata o Liame deve poder liberar, por e-mail, o acesso para um administrador mais experiente ou que conheça o ramo cuidar da conta por ele, como nas contas do Google.

No mercado (base §17.5):

- **Google Ads:** convite por e-mail em "Acesso e segurança", com os níveis Administrador, Padrão, Somente leitura e Somente e-mail, e acesso à cobrança separado. Agências usam a conta de administrador (MCC): o cliente aceita o vínculo e pode desfazê-lo.
- **Meta:** acesso de parceiro ao portfólio empresarial, com permissões por ativo, sem entregar login pessoal.
- **Perfil da Empresa no Google:** proprietário principal, proprietários e administradores. Só o proprietário principal transfere a propriedade.

## Decisão

### Níveis

| Nível | O que pode |
| --- | --- |
| **Dono** | Tudo. É o único que transfere a propriedade, muda a cobrança e exclui a conta. Ninguém o remove. |
| **Administrador** | Campanhas, equipe de agentes, aprovações até o limite, convidar e remover pessoas (menos o dono). Cobrança só se o dono liberar. |
| **Gestor** | Opera campanhas e aprova até o limite. Não convida nem remove pessoas. |
| **Aprovador** | Aprova ou recusa o que a equipe propõe, até o limite. |
| **Somente leitura** | Vê resultados e relatórios. |
| **Só relatórios por e-mail** | Recebe o resumo da semana. Não entra na conta. |

Cada nível é um conjunto de permissões finas (ADR-013). Mais tarde, o tenant poderá ajustar os conjuntos.

### Convite

- Por e-mail, com nível, limite de aprovação por ação, "acima disso eu também aprovo" (ligado por padrão), acesso à cobrança (só para Administrador) e data de fim opcional.
- Link de uso único, guardado só como hash, que vence em **7 dias** e só vale para o e-mail convidado.
- A pessoa cria o próprio login. Administrador, Gestor e Aprovador ativam o app autenticador antes de entrar (ADR-013).
- O dono recebe um aviso quando o convite é aceito.

### Controle do dono

- **Remover acesso na hora:** sessões e tokens da pessoa são revogados no mesmo instante.
- **Tudo registrado:** a auditoria guarda o ator real ("Juliana, administradora"), e o dono recebe por semana o resumo do que cada pessoa fez.
- **Avisos imediatos ao dono:** pessoa nova, limite alterado, conta conectada trocada, cobrança alterada.
- **Ninguém dá mais poder do que tem:** o administrador não cria dono, não aumenta o próprio limite e não libera a cobrança.
- **Aprovação em dois níveis:** acima do limite da pessoa, o dono também aprova.
- **Recuperação da conta do dono** é feita pela DMS, com verificação do CNPJ, nunca pelo administrador.
- **A conta é sempre do dono do negócio.** Diferente do Google Ads, uma agência que cria a conta para o cliente não fica dona dela: a propriedade nasce no e-mail do dono ou é transferida para ele.

### Uma pessoa, várias empresas

- Um mesmo e-mail pode ter acesso a várias empresas (uma `membership` por empresa) e troca de empresa pelo seletor do topo. Isso vale desde a A1.
- **Parceiro** (agência ou consultor com time, cobrança e revenda próprios) vira uma organização do tipo parceiro, com pedido de vínculo aceito pelo dono e desvínculo a qualquer momento. Entra na A7.

### Agentes

O que um agente faz a pedido de um administrador segue o limite desse administrador: o agente nunca tem mais poder do que quem o acionou (ADR-013).

## Consequências

- Gente de fora com acesso aumenta a superfície de ataque. Por isso o app autenticador é obrigatório e o limite padrão devolve gasto grande ao dono.
- O suporte precisa de um fluxo de recuperação da conta do dono (identidade + CNPJ), já que o administrador não pode recuperá-la.
- Na LGPD, quem administra age em nome do cliente (controlador); o Liame continua como operador. Os termos de uso precisam dizer isso.

## Implementação (E2c, 26/09/2026)

- **Convite** (`liame.invitation`, migration 0005): nível (nunca dono), limite de aprovação em micros, aprovação dupla (ligada por padrão), cobrança (só Administrador) e data de fim do acesso. O link é guardado só como hash, vale 7 dias, uma vez e só para o e-mail convidado. Convidar de novo o mesmo e-mail cancela o link anterior. Até 50 convites por empresa por dia.
- **Aceite:** quem não tem conta cria o login pelo próprio convite (o link prova o e-mail, a conta nasce confirmada) e já entra na empresa; quem tem conta aceita logado com o mesmo e-mail, e a empresa do convite vira a ativa. O link vai no corpo da requisição, nunca na URL da API.
- **Ninguém dá mais do que tem:** nível acima do seu, limite acima do seu (ou "sem limite" sem ter), cobrança e dispensa da aprovação dupla só pelo dono. As travas valem para o que muda: o que o dono já concedeu continua quando um administrador mexe em outro campo. Quem passa a aprovar precisa de limite informado.
- **Dono intocável** e **ninguém mexe no próprio acesso** (nem aumenta o próprio limite).
- **Remoção na hora:** toda requisição confere o vínculo, então a próxima chamada da pessoa naquela empresa já é recusada; as sessões seguem valendo para as outras empresas dela. A data de fim funciona do mesmo jeito.
- **Avisos ao dono:** convite aceito (sempre); convite, mudança de acesso e remoção feitos por outra pessoa. Todo e-mail sai depois do commit (`afterCommit`); se a transação desfaz, ninguém recebe aviso do que não aconteceu. Na E5, os envios passam para o outbox.
- **Ainda não:** transferência de propriedade, recuperação da conta do dono pela DMS, resumo semanal por pessoa (depende da auditoria, E3) e o vínculo de parceiro (A7).
