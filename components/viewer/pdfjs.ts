import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// One place configures the worker, so the renderer and the text extractor cannot
// disagree about it. Bundled and same-origin, which also keeps it COEP-safe.
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

export { pdfjsLib };
