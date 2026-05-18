import { Injectable } from '@angular/core';
import { Player, Bullet, Enemy, HighScore, TrailSegment, DifficultyMode } from '../core/diep.interfaces';
import { EnemySpawnerService } from '../enemies/diep.enemy-spawner';
import { HighScoresService } from '../core/diep.high-scores.service';
import { DiepCollisionService } from './subsystems/diep.collision.service';
import { DiepWaveManagerService } from './subsystems/diep.wave-manager';
import { DiepProjectileService } from './subsystems/diep.projectile.service';
import { DiepPlayerService } from './subsystems/diep.player.service';
import { DiepEnemyService } from '../enemies/diep.enemy.service';
import { TransitionManager } from '../ui/diep.transition-manager';
import { AchievementService } from '../core/diep.achievement.service';
import { DiepPlayerUpgradesService } from './subsystems/player-upgrades/diep.player-upgrades.service';
import { DiepArenaManager } from './subsystems/diep.arena-manager';
import { DiepFloorDirector } from './subsystems/diep.arena-floor-director.service';
import { DiepTimeManager } from '../core/diep.time-manager';

@Injectable({ providedIn: 'root' })
export class DiepGameEngineService {
    public width = 800;
    public height = 600;
    public player: Player;
    public bullets: Bullet[] = [];
    public enemies: Enemy[] = [];
    public toxicTrails: TrailSegment[] = [];
    public keys: { [key: string]: boolean } = {};
    public score = 0;
    public sessionKills = 0; 
    public gameOver = false;
    public isPaused = false;
    public isDarkMode = true;
    public isStartingNewGame = false;
    public lastAngle = 0;
    public mouseAiming = true;
    public mousePos = { x: 0, y: 0 };
    public mouseDown = false;
    public isGameStarted = false;
    public deathAnimationTimeStart: number | null = null;
    public enemiesRemainingForAnimation: Enemy[] = [];
    public topScores: HighScore[] = [];
    public showingQuadrivium = false;
    public showingAchievements = false;

    public currentDifficulty: DifficultyMode = 'MEDIUM';
    public persistentXp = 0;

    public transition = new TransitionManager();

    private animationFrameId: number | null = null;
    private lastTime: number = 0;
    private onRenderCallback: () => void = () => {};

    public arenaEnabled = true;

    constructor(
        private spawner: EnemySpawnerService,
        private highScoresService: HighScoresService,
        private collisionService: DiepCollisionService,
        private projectileService: DiepProjectileService,
        private playerService: DiepPlayerService,
        private enemyService: DiepEnemyService,
        public waveManager: DiepWaveManagerService,
        public achievementService: AchievementService,
        private upgradeService: DiepPlayerUpgradesService,
        public arenaManager: DiepArenaManager,
        public hazardDirector: DiepFloorDirector,
    ) {
        this.player = this.playerService.getDefaultPlayer(this.currentDifficulty, this.persistentXp);
        this.topScores = this.highScoresService.getHighScores();
        this.transition.fadeIn();
        this.arenaManager.init(this.width, this.height);
    }

    public startTicker(renderFn: () => void) {
        this.onRenderCallback = renderFn;
        this.lastTime = performance.now();
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
        }
        this.ticker(this.lastTime);
    }

    private ticker = (time: number) => {
    // 1. Update the central clock
    // Pauses game logic if the game is paused OR if it's over (and death anim is done)
    const isLogicPaused = this.isPaused || (this.gameOver && this.deathAnimationTimeStart === null);
    DiepTimeManager.update(isLogicPaused, time);

    // 2. Update UI-dependent systems
    this.transition.update(DiepTimeManager.uiTick * 16.67);

    // 3. Update the game world (logic handled by gameTick internally)
    this.update();

    // 4. Render everything
    this.onRenderCallback();

    // 5. Keep the heart beating
    // This is no longer conditionalized so that UI animations (Main Menu, Game Over) always have a clock to listen to.
    this.animationFrameId = requestAnimationFrame(this.ticker);
}

    public startGameWithFade() {
        this.transition.fadeOut(() => {
            this.resetState(true);
            this.waveManager.startFirstWave(this.enemies, this.width, this.height);
        });
        if (!this.animationFrameId) this.startTicker(this.onRenderCallback);
    }

    public restartGameWithFade() {
        this.transition.fadeOut(() => {
            this.resetState(true);
            this.waveManager.startFirstWave(this.enemies, this.width, this.height);
        });
        if (!this.animationFrameId) this.startTicker(this.onRenderCallback);
    }

    public returnToMainMenuWithFade() {
        this.transition.fadeOut(() => {
            this.resetState(false);
        });
        if (!this.animationFrameId) this.startTicker(this.onRenderCallback);
    }

    public update() {
    // F is our normalized tick (1.0 at 60fps)
    const F = DiepTimeManager.gameTick;
    
    this.arenaManager.update(DiepTimeManager.gameMs);
    if (this.isGameStarted && !this.isPaused && !this.gameOver) {
        this.hazardDirector.update(DiepTimeManager.gameMs, this.width, this.height);
    }

    if (this.gameOver && this.deathAnimationTimeStart) {
        this.handleDeathAnimation(Date.now());
    }

    if (!this.isGameStarted || this.isPaused || this.gameOver) return;

    // 1. Move Player - Replaced deltaTime with 'ms'
    const playerUpdate = this.playerService.update(this.player, this.keys, this.mousePos, this.mouseAiming, this.width, this.height, F, DiepTimeManager.gameMs);
    this.lastAngle = playerUpdate.lastAngle;
    
    if (this.collisionService.handleEnvironmentCollision(this.player)) {
        this.handleGameOver();
        return;
    }

    // 3. Move Bullets - Replaced deltaTime with 'ms'
    this.bullets = this.projectileService.updateBullets(this.bullets, F, this.width, this.height, this.player, DiepTimeManager.gameMs);
    this.bullets.forEach(b => this.collisionService.handleEnvironmentCollision(b, true));

    this.toxicTrails = this.projectileService.updateTrails(this.toxicTrails, this.bullets, this.player, DiepTimeManager.gameMs);

    if (this.mouseAiming && this.mouseDown && this.player.health > 0) {
        this.shootBullet();
    }

    // 4. Update Enemies - Replaced deltaTime with 'ms'
    if (this.player.health > 0) {
        if (!this.isStartingNewGame) {
            this.enemyService.updateAI(this.enemies, this.bullets, this.player, DiepTimeManager.gameMs, this.width, this.height);
            this.enemies.forEach(e => this.collisionService.handleEnvironmentCollision(e));
        } else {
            this.isStartingNewGame = false;
        }
    }

    // 5. Inter-Entity Collisions
    const col = this.collisionService.handleCollisions(this.player, this.bullets, this.enemies, (e) => this.killEnemy(e));
    this.bullets = col.bullets;
    this.enemies = col.enemies;

    if (this.player.health <= 0) {
        this.handleGameOver();
        return;
    }

    this.enemies = this.enemyService.cleanup(this.enemies, this.width, this.height);
    this.waveManager.updateWaves(this.enemies, this.width, this.height);
    this.achievementService.updateProgress('WAVE', this.waveManager.waveCount);
    this.player.x = Math.max(this.player.radius, Math.min(this.width - this.player.radius, this.player.x));
    this.player.y = Math.max(this.player.radius, Math.min(this.height - this.player.radius, this.player.y));
}

    public shootBullet() {
        if (this.gameOver || this.isPaused || !this.isGameStarted) return;
        this.projectileService.shootBullet(this.player, this.mousePos, this.mouseAiming, this.lastAngle, this.bullets,);
    }

    public resetState(startGameImmediately: boolean) {
        if (this.player) { this.persistentXp = this.player.progression.totalXpEarned; }
        this.player = this.playerService.getDefaultPlayer(this.currentDifficulty, this.persistentXp);
        this.bullets = []; 
        this.enemies = []; 
        this.toxicTrails = [];
        this.score = 0; 
        this.sessionKills = 0; 
        this.gameOver = false; 
        this.isPaused = false;
        this.lastAngle = 0; 
        this.isGameStarted = startGameImmediately;
        this.isStartingNewGame = startGameImmediately;
        this.waveManager.reset();
        this.projectileService.resetCooldown();
        this.topScores = this.highScoresService.getHighScores();
        this.showingQuadrivium = false;
        this.showingAchievements = false;
        this.arenaManager.init(this.width, this.height);
    }

    public killEnemy(enemy: Enemy) {
        this.score += enemy.scoreValue;
        this.sessionKills++; 
        this.upgradeService.addXp(this.player.progression, enemy.scoreValue);
        enemy.onDeath?.(this.enemies, this.spawner, enemy, this.player);
        enemy.health = 0;
        const meta = (enemy as any).metadata || {};
        this.achievementService.incrementKills(enemy.type, meta.faction, this.sessionKills);
        this.achievementService.updateProgress('SCORE', this.score);
    }

    private handleGameOver() {
        if (this.player.health <= 0 && !this.gameOver) {
            this.highScoresService.addHighScore(this.score);
            this.topScores = this.highScoresService.getHighScores();
            this.player.health = 0;
            this.gameOver = true;
            this.deathAnimationTimeStart = Date.now();
            this.enemiesRemainingForAnimation = [...this.enemies]; 
            this.enemies = []; 
        }
    }

    public handleDeathAnimation(now: number) {
        if (!this.deathAnimationTimeStart) return;
        if (now - this.deathAnimationTimeStart >= 1000) {
            this.enemiesRemainingForAnimation = [];
            this.deathAnimationTimeStart = null;
        }
    }

    public togglePause() { 
        if (!this.gameOver && this.isGameStarted) {
            this.isPaused = !this.isPaused;
            if (!this.isPaused) this.startTicker(this.onRenderCallback);
        }
        return this.isPaused; 
    }

    public toggleDarkMode() { this.isDarkMode = !this.isDarkMode; }
    
    public getVisibleEnemies(): Enemy[] {
        if (this.gameOver && this.deathAnimationTimeStart !== null) {
            const timeElapsed = Date.now() - this.deathAnimationTimeStart;
            const enemiesToDisappear = Math.floor((timeElapsed / 1000) * this.enemiesRemainingForAnimation.length);
            return this.enemiesRemainingForAnimation.slice(enemiesToDisappear);
        }
        return this.enemies;
    }
}