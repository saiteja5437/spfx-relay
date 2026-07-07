import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Corpus inputs and test fixtures are deliberately bad legacy code; templates
  // are for the emitted SPFx project, which has its own toolchain.
  { ignores: ['dist/**', 'coverage/**', 'corpus/**', 'tests/fixtures/**', 'templates/**', 'webpart/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
