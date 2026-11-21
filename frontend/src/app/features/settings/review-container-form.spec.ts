import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Project } from '../../core/models.js';
import { reviewContainerForm, reviewContainerPatch } from './review-container-form.js';

const project = (fields: Partial<Project>): Project => ({ slug: 'app', name: 'App', repository: '/p/app', ...fields });

test('Review-Container im Formular: Befehle zeilenweise, Standardwerte bleiben leer', () => {
  assert.deepEqual(reviewContainerForm(undefined), {
    reviewCommand: '',
    reviewPort: '',
    reviewHealthPath: '',
    reviewDockerfile: '',
  });
  const form = reviewContainerForm(
    project({
      reviewCommand: ['npm run build', 'npm start -- --port $REVIEW_FRONTEND_PORT'],
      reviewPort: 8080,
      reviewHealthPath: '/health',
      reviewDockerfile: 'deploy/review/Dockerfile',
    }),
  );
  assert.equal(form.reviewCommand, 'npm run build\nnpm start -- --port $REVIEW_FRONTEND_PORT');
  assert.equal(form.reviewPort, '8080');
  assert.equal(form.reviewHealthPath, '/health');
  assert.equal(form.reviewDockerfile, 'deploy/review/Dockerfile');
  assert.equal(reviewContainerForm(project({ reviewPort: null })).reviewPort, '');
});

test('Review-Container speichern: leerer Port wird null, Texte getrimmt', () => {
  assert.deepEqual(
    reviewContainerPatch({
      reviewCommand: ' npm run review \n',
      reviewPort: '',
      reviewHealthPath: ' ',
      reviewDockerfile: '',
    }),
    { reviewCommand: 'npm run review', reviewPort: null, reviewHealthPath: '', reviewDockerfile: '' },
  );
  // Das Zahlenfeld liefert je nach Browser eine Zahl statt eines Textes.
  const numeric = reviewContainerPatch({
    reviewCommand: '',
    reviewPort: 3000 as unknown as string,
    reviewHealthPath: '/',
    reviewDockerfile: ' Dockerfile ',
  });
  assert.equal(numeric.reviewPort, 3000);
  assert.equal(numeric.reviewDockerfile, 'Dockerfile');
});
