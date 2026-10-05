const K_FACTOR = 32
const INITIAL_ELO = 1000

export type GameResult = 'win' | 'loss' | 'draw'

export interface EloInput {
  playerElo: number
  opponentElo: number
  result: GameResult
}

export interface EloOutput {
  newElo: number
  change: number
  expected: number
}

export interface BothPlayersEloOutput {
  winner: EloOutput
  loser: EloOutput
}

export interface DrawEloOutput {
  playerA: EloOutput
  playerB: EloOutput
}

function expectedScore(playerElo: number, opponentElo: number): number {
  return 1 / (1 + Math.pow(10, (opponentElo - playerElo) / 400))
}

function calculateNewElo(playerElo: number, expected: number, actual: number): number {
  return Math.round(playerElo + K_FACTOR * (actual - expected))
}

export function calculateElo({ playerElo, opponentElo, result }: EloInput): EloOutput {
  const actual = result === 'win' ? 1 : result === 'draw' ? 0.5 : 0
  const expected = expectedScore(playerElo, opponentElo)
  const newElo = calculateNewElo(playerElo, expected, actual)

  return {
    newElo,
    change: newElo - playerElo,
    expected: Math.round(expected * 100) / 100,
  }
}

export function calculateMatchElo(
  winnerElo: number,
  loserElo: number
): BothPlayersEloOutput {
  const winner = calculateElo({ playerElo: winnerElo, opponentElo: loserElo, result: 'win' })
  const loser = calculateElo({ playerElo: loserElo, opponentElo: winnerElo, result: 'loss' })

  return { winner, loser }
}

export function calculateDrawElo(
  playerAElo: number,
  playerBElo: number
): DrawEloOutput {
  const playerA = calculateElo({ playerElo: playerAElo, opponentElo: playerBElo, result: 'draw' })
  const playerB = calculateElo({ playerElo: playerBElo, opponentElo: playerAElo, result: 'draw' })

  return { playerA, playerB }
}

export function getInitialElo(): number {
  return INITIAL_ELO
}

export function getRank(elo: number): string {
  if (elo >= 2000) return 'Master'
  if (elo >= 1600) return 'Diamond'
  if (elo >= 1400) return 'Platinum'
  if (elo >= 1200) return 'Gold'
  if (elo >= 1000) return 'Silver'
  return 'Bronze'
}