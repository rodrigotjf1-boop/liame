// Tema escolhido antes da primeira pintura (sem piscar). Sem dependência de Node: o botão de tema
// (cliente) usa a mesma chave.

export const CHAVE_TEMA = 'liame:tema';

export const SCRIPT_TEMA = `try{var t=localStorage.getItem('${CHAVE_TEMA}');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;
