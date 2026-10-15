import { provideHttpClient } from '@angular/common/http';
import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component.js';

bootstrapApplication(AppComponent, {
  providers: [provideHttpClient()],
}).catch((error: unknown) => {
  console.error('Dev Log UI failed to start:', error);
});
