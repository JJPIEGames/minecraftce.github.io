import { defineConfig } from 'vite';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export default defineConfig({
  server: {
    host: '0.0.0.0',
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/main.ts'),
      name: 'Fieldcraft',
      formats: ['iife'],
      fileName: 'fieldcraft',
      cssFileName: 'fieldcraft',
    },
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  plugins: [{
    name: 'standalone-html',
    apply: 'build',
    async closeBundle() {
      const outputDirectory = resolve(__dirname, 'dist');
      const [html, script, styles] = await Promise.all([
        readFile(resolve(__dirname, 'index.html'), 'utf8'),
        readFile(resolve(outputDirectory, 'fieldcraft.iife.js'), 'utf8'),
        readFile(resolve(outputDirectory, 'fieldcraft.css'), 'utf8'),
      ]);
      const sourceEntry = '<script type="module" src="/src/main.ts"></script>';
      if (!html.includes(sourceEntry)) throw new Error('Could not find the source entry script in index.html.');
      const stylesPlaceholder = '<!-- FIELDCRAFT_STYLES -->';
      const scriptPlaceholder = '<!-- FIELDCRAFT_SCRIPT -->';
      const template = html
        .replace(sourceEntry, '')
        .replace('</head>', `${stylesPlaceholder}\n  </head>`)
        .replace('</body>', `${scriptPlaceholder}\n  </body>`);
      const standaloneHtml = template
        .replace(stylesPlaceholder, () => `<style>${styles.replace(/<\/style/gi, '<\\/style')}</style>`)
        .replace(scriptPlaceholder, () => `<script>${script.replace(/<\/script/gi, '<\\/script')}</script>`);
      await writeFile(resolve(outputDirectory, 'index.html'), standaloneHtml);
    },
  }],
});
