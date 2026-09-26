import { redirect } from 'next/navigation';

// Página inicial provisória da A1: a única tela do app logado é "Pessoas e acessos". O Resumo (Lite) e a
// Atenção (Pro) chegam com os dados de marketing (A2 em diante, roadmap).
export default function Home() {
  redirect('/pessoas');
}
