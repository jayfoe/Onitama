;(function() {
  function wrap(uuid, Participant, game, utils, AppError, cards,
                {WHITE, BLACK, PARTICIPANT}) {
    function GameSession(priorSession, options={}) {
      this.white = null;
      this.black = null;
      this.whiteJoinCode = null;
      this.blackJoinCode = null;

      this.observers = [];
      this.purgatory = [];
      this.id = uuid();
      this.deck = options.deck ? options.deck : cards.deck;
      this._stateChangeHandlers = [];
      this._lockedName = options.name || null;
      this._lastSessionId = null;

      this.joinTime = 60 * 30;
      this.moveTime = 60 * 30;
      this.terminationProcess = null;
      this.lastActionAt = Date.now();
      this.terminatedAt = null;

      if (priorSession) {
        this._lastSessionId = priorSession.id;
        this.whiteJoinCode = uuid();
        this.blackJoinCode = uuid();
        this.deck = priorSession.deck;
      }

      this.gameState = new game.GameState().initialize(this.deck);
      this.bumpMoveTimer();
    }

    GameSession.prototype = {
      bumpMoveTimer() {
        if (this.terminationProcess) {
          clearTimeout(this.terminationProcess);
        }

        this.lastActionAt = Date.now();

        this.terminationProcess = setTimeout(() => {
          this.terminate();
        }, (this.gameState.started?this.moveTime:this.joinTime) * 1000);
      },
      publish(eventName, event) {
        this.broadcast(null, eventName, event);
      },
      broadcast(except, eventName, event) {
        this.observers
          .filter(observer => observer !== except)
          .forEach(observer => observer.emit(eventName, event));
      },
      isAwaitingParticipant() {
        return this.white === null || this.black === null;
      },
      handleDisconnect(observer) {
        utils.removeFromArray(this.observers, observer);
        if (observer === this.black) this.black = null;
        if (observer === this.white) this.white = null;

        this.purgatory.push(observer);

        this.publish('participantDisconnected', {
          color: observer.color,
          name: observer.name
        });
        this._changeState();
      },
      announceNewParticipant(participant) {
        this.broadcast(participant, 'roleAssigned', {
          color: participant.color,
          id: participant.id,
          name: participant.name
        });
      },
      acceptParticipant(socket, name, joinCode) {
        var color, participant;

        if (this.whiteJoinCode && this.blackJoinCode) {
          // Join codes exist
          if (this.whiteJoinCode === joinCode) {
            participant = new Participant(socket, this, name, WHITE);
            this.white = participant;
            color = WHITE;
          } else if (this.blackJoinCode === joinCode) {
            participant = new Participant(socket, this, name, BLACK);
            this.black = participant;
            color = BLACK;
          } else {
            participant = new Participant(socket, this, name, PARTICIPANT);
            color = PARTICIPANT;
          }
        } else {
          // No join codes exist
          if (this.gameState.started) {
            participant = new Participant(socket, this, name, PARTICIPANT);
            color = PARTICIPANT;
          } else if (this.white === null) {
            participant = new Participant(socket, this, name, WHITE);
            this.white = participant;
            color = WHITE;
          } else if (this.black === null) {
            participant = new Participant(socket, this, name, BLACK);
            this.black = participant;
            color = BLACK;
          }
        }

        participant.assignRole();
        this.observers.push(participant);
        this.announceNewParticipant(participant);

        participant.on('disconnect',
                       this.handleDisconnect.bind(this, participant));

        if (!this.gameState.started && this.black && this.white) {
          this._lockedName = this.getName();
          this.gameState.start();
          this.publish('gameStarted', {});
        }

        this.bumpMoveTimer();
        this._changeState();

        return participant;
      },
      attemptRejoin(socket, rejoinCode) {
        const rejoiner = this.purgatory
          .filter(o => o.rejoinCode === rejoinCode)[0];

        if (rejoiner) {
          rejoiner.rejoin(socket);
          if (rejoiner.color === BLACK) {
            this.black = rejoiner;
          } else if (rejoiner.color === WHITE) {
            this.white = rejoiner;
          }

          this.observers.push(rejoiner);
          utils.removeFromArray(this.purgatory, rejoiner);
          this.announceNewParticipant(rejoiner);

          return rejoiner;
        } else {
          throw new AppError('Invalid rejoin code.', 'INVALID_REJOIN_CODE');
        }
      },
      proposeRematch(participant) {
        if (participant.color !== WHITE && participant.color !== BLACK) {
          throw new AppError('Non-player proposed a rematch. Error.');
        }

        if (this.black.rematchAccepted && this.white.rematchAccepted) {
          this.black.emit('->rematch', {
          });
        } else {
          this.broadcast(participant, 'rematchProposed', {
            proposerName: participant.name,
            proposerId: participant.id,
            proposerColor: participant.color
          });
        }
      },
      submitMove(move, participant) {
        const piece = this.gameState.getCellContents(...move.initialPosition),
          card = this.gameState.localizeCard(move.card);

        if (!piece || piece.getColor() !== participant.color) {
          throw new AppError(
            `Piece at ${move.initialPosition} does not belong to ${participant.color}`,
            'INVALID_MOVE');
        }

        const validation = this.gameState.validateMove(
          move.initialPosition,
          move.targetPosition,
          card);

        if (!validation.valid) {
          throw new AppError(
            `Move did not validate. Reason: ${validation.reason}`,
            'INVALID_MOVE');
        } else {
          this.gameState.executeMove(
            move.initialPosition,
            move.targetPosition,
            card);

          this.bumpMoveTimer();
          participant.emit('moveAccepted', move);
          this.broadcast(participant, 'moveMade', move);
        }
      },
      submitChatMessage(sender, message) {
        this.publish('chatMessage', {
          message: message,
          senderName: sender.name
        });
      },
      onStateChange(callback) {
        this._stateChangeHandlers.push(callback);
      },
      _changeState(info) {
        this._stateChangeHandlers.forEach(cb => cb(info));
      },
      getSpectators() {
        return Math.max(this.observers.length - 2, 0);
      },
      _getPlayers() {
        return [this.white, this.black].filter(p => p);
      },
      getName() {
        const players = this._getPlayers();
        if (this._lockedName) {
          return this._lockedName;
        } else if (players.length === 0) {
          return 'A newly created game'
        } else if (players.length === 1) {
          return `${ players[0].name } vs. ...`;
        } else {
          return `${ players[0].name } vs. ${ players[1].name }`;
        }
      },
      getState() {
        if (this.terminatedAt !== null) {
          if (this.gameState.winner) {
            return `done, ${ this.gameState.winner } won`;
          } else {
            return 'abandoned';
          }
        } else if (!this.gameState.started) {
          if (!(this.white) && !(this.black)) {
            return 'awaiting two more players';
          } else {
            return 'awaiting one more player';
          }
        } else {
          return 'in progresss';
        }
      },
      terminate(reason='NOT_GIVEN') {
        this.gameState.terminate();
        this.terminatedAt = Date.now();
        this.observers.forEach(observer =>
          observer.emit('gameTerminated', { reason }));
        this._changeState();
      },
      lastCall() {
        this.observers.forEach(observer => observer.socket.disconnect());
      }
    };

    return GameSession;
  }

  define([
    'uuid/v4',
    'participant',
    'game',
    'utils',
    'application-error',
    'cards',
    'colors'
  ], wrap);
})();
