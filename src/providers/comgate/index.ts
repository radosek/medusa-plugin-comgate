import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import ComgateProviderService from "./service"

export default ModuleProvider(Modules.PAYMENT, {
	services: [ComgateProviderService],
})

export { ComgateProviderService }
export * from "./types"
