import { Toast } from '@douyinfe/semi-ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'

/** 看板上的一次写操作：run 发请求，done 是成功后的提示。 */
export interface BoardTask {
  run: () => Promise<unknown>
  done: string
}

/**
 * 看板的写操作：成功提示并让全部查询过期重读；失败也重读一次（多半是别人刚改过：状态变了、计时版本过期），
 * 错误原文由调用方显示在操作旁边，员工看过新状态后自己再点——不自动换版本重提，也不做乐观更新。
 */
export function useBoardAction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (task: BoardTask) => task.run(),
    onSuccess: (_result, task) => {
      Toast.success(task.done)
      void queryClient.invalidateQueries()
    },
    onError: () => {
      void queryClient.invalidateQueries()
    },
  })
}
