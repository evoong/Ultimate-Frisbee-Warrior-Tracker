import { useState, useCallback, useRef } from 'react'
import { supabase } from '../../lib/supabase'

export type StrategyPlay = { id: number; name: string; created_at: string; game_id: number | null }
export type StrategyStep = { id: number; play_id: number; step_number: number }
export type StrategyPosition = { player_id: number; x: number; y: number }
export type StrategyOpponentMarker = { id: number; label: string; x: number; y: number }
export type StrategyTextBox = { id: number; text: string; x: number; y: number }
export type StrategyArrow = {
  id: number
  x1: number; y1: number
  x2: number; y2: number
  cx: number; cy: number
  arrow_type: 'run' | 'throw'
  start_player_id: number | null
  start_opponent_id: number | null
}

// A board element that can be selected (player, opponent marker, text box, or arrow).
export type StrategySelectedItem = { kind: 'player' | 'opponent' | 'textbox' | 'arrow'; id: number }
// A relative move applied to a multi-selection during a group drag. Arrows
// carry all six curve coordinates plus start_player_id/start_opponent_id (a
// group move detaches an anchored arrow so the whole shape translates rigidly).
export type StrategyEntityMove =
  | { kind: 'player'; id: number; x: number; y: number }
  | { kind: 'opponent'; id: number; x: number; y: number }
  | { kind: 'textbox'; id: number; x: number; y: number }
  | { kind: 'arrow'; id: number; x1: number; y1: number; x2: number; y2: number; cx: number; cy: number; start_player_id: number | null; start_opponent_id: number | null }

type HookResult<T, P = void> = {
  data: T | undefined
  loading: boolean
  error: string | null
  trigger: P extends void ? () => Promise<T | undefined> : (params?: P) => Promise<T | undefined>
}

function useApiCall<T, P = void>(fn: (params: P) => Promise<T>): HookResult<T, P> {
  const [data, setData] = useState<T | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seqRef = useRef(0)

  const trigger = useCallback(async (params?: P) => {
    // Guard against out-of-order responses: only the latest call may set state
    const callId = ++seqRef.current
    setLoading(true)
    setError(null)
    try {
      const result = await fn(params as P)
      if (callId === seqRef.current) setData(result)
      return result
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (callId === seqRef.current) setError(msg)
      return undefined
    } finally {
      if (callId === seqRef.current) setLoading(false)
    }
  }, [fn])

  return { data, loading, error, trigger: trigger as HookResult<T, P>['trigger'] }
}

export function useGetStrategyPlays() {
  const fn = useCallback(async (params: { organizationId: number | null }) => {
    const { data, error } = await supabase
      .from('strategy_plays')
      .select('*')
      .eq('organization_id', params.organizationId)
      .order('created_at')
    if (error) throw new Error(error.message)
    return (data ?? []) as StrategyPlay[]
  }, [])
  return useApiCall<StrategyPlay[], { organizationId: number | null }>(fn)
}

// Every play needs at least one step, so creation inserts the play and its
// first step together; callers never have to special-case a stepless play.
export function useCreateStrategyPlay() {
  const fn = useCallback(async (params: { organizationId: number | null; name: string; game_id?: number | null }) => {
    const { data, error } = await supabase
      .from('strategy_plays')
      .insert({ organization_id: params.organizationId, name: params.name, game_id: params.game_id ?? null })
      .select()
    if (error) throw new Error(error.message)
    const play = data?.[0] as StrategyPlay
    const { data: stepData, error: stepError } = await supabase
      .from('strategy_steps')
      .insert({ organization_id: params.organizationId, play_id: play.id, step_number: 1 })
      .select()
    if (stepError) throw new Error(stepError.message)
    return { ...play, firstStepId: (stepData?.[0] as { id: number }).id }
  }, [])
  return useApiCall<StrategyPlay & { firstStepId: number }, { organizationId: number | null; name: string; game_id?: number | null }>(fn)
}

export function useUpdateStrategyPlay() {
  const fn = useCallback(async (params: { id: number; name?: string; game_id?: number | null }) => {
    const { id, ...body } = params
    const { error } = await supabase
      .from('strategy_plays')
      .update(body)
      .eq('id', id)
    if (error) throw new Error(error.message)
  }, [])
  return useApiCall<void, { id: number; name?: string; game_id?: number | null }>(fn)
}

// Deleting a play cascades to its steps, which cascade to their
// positions/opponent markers/arrows.
export function useDeleteStrategyPlay() {
  const fn = useCallback(async (params: { id: number }) => {
    const { error } = await supabase
      .from('strategy_plays')
      .delete()
      .eq('id', params.id)
    if (error) throw new Error(error.message)
  }, [])
  return useApiCall<void, { id: number }>(fn)
}

export function useGetStrategySteps() {
  const fn = useCallback(async (params: { playId: number }) => {
    const { data, error } = await supabase
      .from('strategy_steps')
      .select('id, play_id, step_number')
      .eq('play_id', params.playId)
      .order('step_number')
    if (error) throw new Error(error.message)
    return (data ?? []) as StrategyStep[]
  }, [])
  return useApiCall<StrategyStep[], { playId: number }>(fn)
}

export function useAddStrategyStep() {
  const fn = useCallback(async (params: { organizationId: number | null; playId: number }) => {
    const { data: existing, error: fetchError } = await supabase
      .from('strategy_steps')
      .select('step_number')
      .eq('play_id', params.playId)
      .order('step_number', { ascending: false })
      .limit(1)
    if (fetchError) throw new Error(fetchError.message)
    const nextNumber = ((existing?.[0] as { step_number: number } | undefined)?.step_number ?? 0) + 1
    const { data, error } = await supabase
      .from('strategy_steps')
      .insert({ organization_id: params.organizationId, play_id: params.playId, step_number: nextNumber })
      .select()
    if (error) throw new Error(error.message)
    return data?.[0] as StrategyStep
  }, [])
  return useApiCall<StrategyStep, { organizationId: number | null; playId: number }>(fn)
}

// Deleting a step cascades to its positions/opponent markers/arrows. The
// caller is responsible for not letting a play drop to zero steps.
export function useDeleteStrategyStep() {
  const fn = useCallback(async (params: { stepId: number }) => {
    const { error } = await supabase
      .from('strategy_steps')
      .delete()
      .eq('id', params.stepId)
    if (error) throw new Error(error.message)
  }, [])
  return useApiCall<void, { stepId: number }>(fn)
}

export function useGetStrategyPositions() {
  const fn = useCallback(async (params: { stepId: number }) => {
    const { data, error } = await supabase
      .from('strategy_positions')
      .select('player_id, x, y')
      .eq('step_id', params.stepId)
    if (error) throw new Error(error.message)
    return (data ?? []) as StrategyPosition[]
  }, [])
  return useApiCall<StrategyPosition[], { stepId: number }>(fn)
}

// Upsert so moving an already-placed player writes the same row (see
// useSetAttendance for the same onConflict pattern). Returns true so the
// caller can tell success from a failed trigger (which returns undefined),
// letting the page revert its optimistic update.
export function useUpsertStrategyPosition() {
  const fn = useCallback(async (params: { organizationId: number | null; stepId: number; playerId: number; x: number; y: number }) => {
    const { error } = await supabase
      .from('strategy_positions')
      .upsert(
        { organization_id: params.organizationId, step_id: params.stepId, player_id: params.playerId, x: params.x, y: params.y },
        { onConflict: 'step_id,player_id' }
      )
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { organizationId: number | null; stepId: number; playerId: number; x: number; y: number }>(fn)
}

export function useDeleteStrategyPosition() {
  const fn = useCallback(async (params: { stepId: number; playerId: number }) => {
    const { error } = await supabase
      .from('strategy_positions')
      .delete()
      .eq('step_id', params.stepId)
      .eq('player_id', params.playerId)
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { stepId: number; playerId: number }>(fn)
}

export function useGetStrategyOpponentMarkers() {
  const fn = useCallback(async (params: { stepId: number }) => {
    const { data, error } = await supabase
      .from('strategy_opponent_markers')
      .select('id, label, x, y')
      .eq('step_id', params.stepId)
      .order('id')
    if (error) throw new Error(error.message)
    return (data ?? []) as StrategyOpponentMarker[]
  }, [])
  return useApiCall<StrategyOpponentMarker[], { stepId: number }>(fn)
}

export function useCreateStrategyOpponentMarker() {
  const fn = useCallback(async (params: { organizationId: number | null; stepId: number; label: string; x: number; y: number }) => {
    const { data, error } = await supabase
      .from('strategy_opponent_markers')
      .insert({ organization_id: params.organizationId, step_id: params.stepId, label: params.label, x: params.x, y: params.y })
      .select()
    if (error) throw new Error(error.message)
    return data?.[0] as StrategyOpponentMarker
  }, [])
  return useApiCall<StrategyOpponentMarker, { organizationId: number | null; stepId: number; label: string; x: number; y: number }>(fn)
}

export function useUpdateStrategyOpponentMarker() {
  const fn = useCallback(async (params: { id: number; x?: number; y?: number; label?: string }) => {
    const { id, ...body } = params
    const { error } = await supabase
      .from('strategy_opponent_markers')
      .update(body)
      .eq('id', id)
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { id: number; x?: number; y?: number; label?: string }>(fn)
}

export function useDeleteStrategyOpponentMarker() {
  const fn = useCallback(async (params: { id: number }) => {
    const { error } = await supabase
      .from('strategy_opponent_markers')
      .delete()
      .eq('id', params.id)
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { id: number }>(fn)
}

export function useGetStrategyTextBoxes() {
  const fn = useCallback(async (params: { stepId: number }) => {
    const { data, error } = await supabase
      .from('strategy_text_boxes')
      .select('id, text, x, y')
      .eq('step_id', params.stepId)
      .order('id')
    if (error) throw new Error(error.message)
    return (data ?? []) as StrategyTextBox[]
  }, [])
  return useApiCall<StrategyTextBox[], { stepId: number }>(fn)
}

export function useCreateStrategyTextBox() {
  const fn = useCallback(async (params: { organizationId: number | null; stepId: number; text: string; x: number; y: number }) => {
    const { data, error } = await supabase
      .from('strategy_text_boxes')
      .insert({ organization_id: params.organizationId, step_id: params.stepId, text: params.text, x: params.x, y: params.y })
      .select()
    if (error) throw new Error(error.message)
    return data?.[0] as StrategyTextBox
  }, [])
  return useApiCall<StrategyTextBox, { organizationId: number | null; stepId: number; text: string; x: number; y: number }>(fn)
}

export function useUpdateStrategyTextBox() {
  const fn = useCallback(async (params: { id: number; x?: number; y?: number; text?: string }) => {
    const { id, ...body } = params
    const { error } = await supabase
      .from('strategy_text_boxes')
      .update(body)
      .eq('id', id)
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { id: number; x?: number; y?: number; text?: string }>(fn)
}

export function useDeleteStrategyTextBox() {
  const fn = useCallback(async (params: { id: number }) => {
    const { error } = await supabase
      .from('strategy_text_boxes')
      .delete()
      .eq('id', params.id)
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { id: number }>(fn)
}

export function useGetStrategyArrows() {
  const fn = useCallback(async (params: { stepId: number }) => {
    const { data, error } = await supabase
      .from('strategy_arrows')
      .select('id, x1, y1, x2, y2, cx, cy, arrow_type, start_player_id, start_opponent_id')
      .eq('step_id', params.stepId)
      .order('id')
    if (error) throw new Error(error.message)
    return (data ?? []) as StrategyArrow[]
  }, [])
  return useApiCall<StrategyArrow[], { stepId: number }>(fn)
}

export function useCreateStrategyArrow() {
  const fn = useCallback(async (params: {
    organizationId: number | null; stepId: number; x1: number; y1: number; x2: number; y2: number; cx: number; cy: number; arrow_type: 'run' | 'throw'; start_player_id?: number | null; start_opponent_id?: number | null
  }) => {
    const { data, error } = await supabase
      .from('strategy_arrows')
      .insert({
        organization_id: params.organizationId,
        step_id: params.stepId,
        x1: params.x1, y1: params.y1, x2: params.x2, y2: params.y2, cx: params.cx, cy: params.cy,
        arrow_type: params.arrow_type,
        start_player_id: params.start_player_id ?? null,
        start_opponent_id: params.start_opponent_id ?? null,
      })
      .select()
    if (error) throw new Error(error.message)
    return data?.[0] as StrategyArrow
  }, [])
  return useApiCall<StrategyArrow, { organizationId: number | null; stepId: number; x1: number; y1: number; x2: number; y2: number; cx: number; cy: number; arrow_type: 'run' | 'throw'; start_player_id?: number | null; start_opponent_id?: number | null }>(fn)
}

// start_player_id/start_opponent_id are included so dragging an anchored
// arrow's start handle can detach it (caller passes null for both) instead
// of leaving it pointing at a stale, no-longer-tracked coordinate.
export function useUpdateStrategyArrow() {
  const fn = useCallback(async (params: { id: number; x1: number; y1: number; x2: number; y2: number; cx: number; cy: number; start_player_id?: number | null; start_opponent_id?: number | null }) => {
    const { id, ...body } = params
    const { error } = await supabase
      .from('strategy_arrows')
      .update(body)
      .eq('id', id)
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { id: number; x1: number; y1: number; x2: number; y2: number; cx: number; cy: number; start_player_id?: number | null; start_opponent_id?: number | null }>(fn)
}

export function useDeleteStrategyArrow() {
  const fn = useCallback(async (params: { id: number }) => {
    const { error } = await supabase
      .from('strategy_arrows')
      .delete()
      .eq('id', params.id)
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { id: number }>(fn)
}
