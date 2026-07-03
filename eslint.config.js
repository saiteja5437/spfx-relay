import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Corpus inputs and test fixtures are deliberately bad legacy code — never lint them.
  { ignores: ['dist/**', 'coverage/**', 'corpus/**', 'tests/fixtures/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
