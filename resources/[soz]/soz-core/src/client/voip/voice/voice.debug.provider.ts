import { Command } from '../../../core/decorators/command';
import { Inject } from '../../../core/decorators/injectable';
import { Provider } from '../../../core/decorators/provider';
import { Tick } from '../../../core/decorators/tick';
import { NuiDispatch } from '../../nui/nui.dispatch';
import { VoipService } from '../voip.service';
import { VoiceListeningService } from './voice.listening.service';
import { VoiceTargetService } from './voice.target.service';

@Provider()
export class VoiceDebugProvider {
    @Inject(NuiDispatch)
    private readonly nuiDispatch: NuiDispatch;

    @Inject(VoipService)
    private voipService: VoipService;

    @Inject(VoiceTargetService)
    private voiceTargetService: VoiceTargetService;

    @Inject(VoiceListeningService)
    private voiceListeningService: VoiceListeningService;

    private inDebug = false;

    @Command('voip-debug')
    public voipDebug() {
        this.inDebug = !this.inDebug;
    }

    @Tick(50)
    public debugVoipTick() {
        if (!this.inDebug) {
            this.nuiDispatch.dispatch('hud', 'VoipDebug', null);

            return;
        }

        this.nuiDispatch.dispatch('hud', 'VoipDebug', {
            proximity: MumbleGetTalkerProximity(),
            networkProximity: NetworkGetTalkerProximity(),
            listeners: this.voiceListeningService.getListeners(),
            targets: this.voiceTargetService.getTargets(),
            voiceMode: this.voipService.getVoiceMode(),
            overrideInputRange: this.voipService.getOverrideInputRange(),
            submixes: this.voiceListeningService.getSubmixes(),
        });
    }
}
