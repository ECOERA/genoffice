import type { en } from './en'

export const es = {
  todName: 'Tod',
  todAria: 'Tod, el asistente de Office',
  todHide: 'Despedir a Tod',
  todRestore: 'Traer de vuelta a Tod',
  todClose: 'Cerrar',
  todGotIt: 'Entendido',
  todAnotherTip: 'Otro más',
  todStopTips: 'No mostrar sugerencias',
  todQuieted: 'De acuerdo. Estaré bajo la arena.',
  todGreeting: 'Hola, soy Tod. Parece que estás trabajando. ¿Te echo una mano?',

  todBreakTitle: '¿Un descanso?',
  todBreakBody: 'Llevas {minutes} minutos seguidos. El desierto te llama.',
  todBreakGo: 'Cabalgar el gusano',
  todBreakLater: 'Todavía no',

  todTipGeneric1: 'Parece que estás escribiendo algo. ¿Quieres ayuda?',
  todTipGeneric2: 'Pulsa ⌘S de vez en cuando. La especia debe fluir, y tus guardados también.',
  todTipGeneric3: 'Todos los documentos que has abierto siguen en Recientes. Lo he comprobado.',
  todTipGeneric4: '⌘Z lo deshace. El desierto no tiene esa cortesía.',

  todTipDocs1: 'Parece que estás escribiendo una carta. ¿Quieres ayuda?',
  todTipDocs2: '⌘B para negrita, ⌘I para cursiva. Las dos juntas piden una buena razón.',
  todTipSheets1: 'Parece que estás montando un presupuesto. No diré nada.',
  todTipSheets2: 'Una fórmula tan larga que hay que desplazarse de lado quiere ser dos fórmulas.',
  todTipSlides1: 'Parece que estás haciendo diapositivas. Una idea por diapositiva basta.',
  todTipSlides2:
    'Pasados seis puntos en una diapositiva, la sala se pone a leer en vez de escuchar.',
  todTipPdf1: 'Parece que estás leyendo un PDF. Puedes anotarlo directamente en la página.',
  todTipPdf2: 'Un PDF es papel impreso. Aun así puedes garabatear encima.',
  todTipMarkdown1:
    'Parece que estás escribiendo Markdown. Dos espacios cortan la línea; una línea en blanco, el párrafo.',
  todTipMarkdown2: '# es un título, ## uno más pequeño. Por debajo ya no lee nadie.',
  todTipHome1: 'Parece que buscas un documento. Prueba en Recientes.',
  todTipHome2:
    'La especia debe fluir, y tus archivos también. Marca con estrella los que reabres siempre.',
} satisfies Record<keyof typeof en, string>
