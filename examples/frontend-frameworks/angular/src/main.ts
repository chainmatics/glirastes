import { Component, ElementRef, ViewChild, afterNextRender, inject, DestroyRef, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { Router, RouterOutlet, provideRouter } from '@angular/router';

@Component({selector:'fixture-chat',standalone:true,template:'<div #host></div>'})
class Chat {
  @ViewChild('host',{static:true}) host!: ElementRef<HTMLElement>;
  private router=inject(Router);
  constructor() {
    const controller=new AbortController();
    inject(DestroyRef).onDestroy(()=>controller.abort());
    // afterNextRender is browser-only, so SSR never evaluates the embed module.
    afterNextRender(()=> { void import('../../shared/mount-chat').then(({mountChat})=>mountChat(this.host.nativeElement,{
      framework:'angular',signal:controller.signal,push:href=>this.router.navigateByUrl(href),
    })).catch(error=>{if(!controller.signal.aborted) console.error(error);}); });
  }
}
@Component({standalone:true,template:'<h1>Home</h1>'}) class Home {}
@Component({standalone:true,template:'<h1>Overview</h1>'}) class Overview {}
@Component({selector:'app-root',standalone:true,imports:[RouterOutlet,Chat],template:`
  <h2>Angular reference</h2><router-outlet />
  <p data-testid="highlight-target">Highlight target</p>
  <button (click)="mounted.set(!mounted())">{{mounted() ? 'Unmount chat' : 'Mount chat'}}</button>
  @if(mounted()) { <fixture-chat /> }
`})
class App { mounted=signal(true); }
bootstrapApplication(App,{providers:[provideRouter([{path:'',component:Home},{path:'overview',component:Overview}])]}).catch(console.error);
