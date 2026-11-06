import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { VisibilityMonitorComponent } from './features/visibility-monitor/visibility-monitor.component';

@Component({
  imports: [RouterOutlet, VisibilityMonitorComponent],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  protected readonly title = signal('prueba');
}
