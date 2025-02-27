import axios from 'axios';

import { On, Once, OnEvent } from '../../core/decorators/event';
import { Exportable } from '../../core/decorators/exports';
import { Inject } from '../../core/decorators/injectable';
import { Provider } from '../../core/decorators/provider';
import { Rpc } from '../../core/decorators/rpc';
import { Permissions } from '../../core/permissions';
import { ServerEvent } from '../../shared/event';
import {
    PlayerClientState,
    PlayerData,
    PlayerLicenceType,
    PlayerListStateKey,
    PlayerServerState,
} from '../../shared/player';
import { RpcServerEvent } from '../../shared/rpc';
import { PermissionService } from '../permission.service';
import { QBCore } from '../qbcore';
import { ServerStateService } from '../server.state.service';
import { PlayerListStateService } from './player.list.state.service';
import { PlayerStateService } from './player.state.service';

@Provider()
export class PlayerProvider {
    @Inject(QBCore)
    private QBCore: QBCore;

    @Inject(Permissions)
    private permissions: Permissions;

    @Inject(PermissionService)
    private permissionService: PermissionService;

    @Inject(PlayerStateService)
    private playerStateService: PlayerStateService;

    @Inject(ServerStateService)
    private serverStateService: ServerStateService;

    @Inject(PlayerListStateService)
    private playerListStateService: PlayerListStateService;

    private jwtTokenCache: Record<string, string> = {};

    @On('QBCore:Server:PlayerLoaded', false)
    onPlayerLoaded(data: any) {
        const player = data.PlayerData as PlayerData;

        // This is an event from qb when player is fully loaded but screen is not faded out so we dont' trigger client event
        this.permissions.addPlayerRole(player.source, player.role);
        this.serverStateService.addPlayer(player);
        this.playerStateService.setClientState(player.source, {
            isWearingPatientOutfit: false,
            isInventoryBusy: false,
            isDead: player.metadata.isdead,
        });
        this.playerListStateService.handlePlayer(player, this.playerStateService.getClientState(player.source));

        TriggerEvent(ServerEvent.PLAYER_LOADED, player.source, player);
    }

    @On('QBCore:Server:PlayerUpdate', false)
    onPlayerUpdate(player: PlayerData) {
        this.serverStateService.updatePlayer(player);
        this.playerListStateService.handlePlayer(player, this.playerStateService.getClientState(player.source));
    }

    @On('QBCore:Server:PlayerUnload', false)
    onPlayerUnload(source: number) {
        this.serverStateService.removePlayer(source);
        this.playerListStateService.removePlayer(source);
    }

    @Once()
    onStart() {
        const connectedSources = this.QBCore.getPlayersSources();

        for (const source of connectedSources) {
            const player = this.QBCore.getPlayer(source);

            this.serverStateService.addPlayer(player.PlayerData);
            this.permissions.addPlayerRole(source, player.PlayerData.role);
            this.playerListStateService.handlePlayer(
                player.PlayerData,
                this.playerStateService.getClientState(player.PlayerData.source)
            );

            // Trigger client event to existing clieant (only useful for dev)
            TriggerClientEvent('QBCore:Client:OnPlayerLoaded', player.PlayerData.source);
        }
    }

    @Rpc(RpcServerEvent.PLAYER_GET_SERVER_STATE)
    public getServerState(source: number): PlayerServerState {
        return this.playerStateService.getServerState(source);
    }

    @Rpc(RpcServerEvent.PLAYER_GET_CLIENT_STATE)
    public getClientState(source: number, target: number | null): PlayerClientState {
        return this.playerStateService.getClientState(target ?? source);
    }

    @Rpc(RpcServerEvent.PLAYER_GET_LIST_STATE)
    public getListState(): Record<PlayerListStateKey, number[]> {
        return this.playerListStateService.getStates();
    }

    @Exportable('GetPlayerState')
    public getState(source: number): PlayerClientState {
        return this.playerStateService.getClientState(source);
    }

    @Exportable('SetPlayerState')
    @OnEvent(ServerEvent.PLAYER_UPDATE_STATE)
    public setPlayerClientState(source: number, stateUpdate: Partial<PlayerClientState>): PlayerClientState {
        return this.playerStateService.setClientState(source, stateUpdate);
    }

    @Rpc(RpcServerEvent.PLAYER_GET_JWT_TOKEN)
    public async getJwtToken(source: number): Promise<string | null> {
        const steam = this.playerStateService.getIdentifier(source.toString());

        if (this.jwtTokenCache[steam]) {
            return this.jwtTokenCache[steam];
        }

        const url = GetConvar('soz_api_endpoint', 'https://api.soz.zerator.com') + '/accounts/create-token/' + steam;

        const response = await axios.get(url, {
            auth: {
                username: GetConvar('soz_api_username', 'admin'),
                password: GetConvar('soz_api_password', 'admin'),
            },
            validateStatus: () => true,
        });

        if (response.status === 200) {
            this.jwtTokenCache[steam] = response.data.token;
            return response.data.toString();
        }

        return null;
    }

    @Rpc(RpcServerEvent.PLAYER_GET_LICENCES)
    public async getLicences(source: number, target: number): Promise<Partial<Record<PlayerLicenceType, number>>> {
        return this.serverStateService.getPlayer(target).metadata.licences;
    }
}
