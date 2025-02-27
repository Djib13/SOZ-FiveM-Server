import { Cron } from '../../core/decorators/cron';
import { Inject } from '../../core/decorators/injectable';
import { Provider } from '../../core/decorators/provider';
import { Logger } from '../../core/logger';
import { isErr } from '../../shared/result';
import { JobService } from '../job.service';
import { Monitor } from '../monitor/monitor';
import { ConfigurationRepository } from '../repository/configuration.repository';
import { BankService } from './bank.service';

@Provider()
export class BankTaxProvider {
    @Inject(JobService)
    private jobService: JobService;

    @Inject(BankService)
    private bankService: BankService;

    @Inject(ConfigurationRepository)
    private configurationRepository: ConfigurationRepository;

    @Inject(Logger)
    private logger: Logger;

    @Inject(Monitor)
    private monitor: Monitor;

    @Cron(5, 0, 3)
    public async paySocietyTaxes() {
        const jobs = Object.values(this.jobService.getJobs());

        for (const job of jobs) {
            const account = job.taxCollectAccounts || [];

            if (account.length === 0) {
                continue;
            }

            let societyMoney = 0;

            for (const acc of account) {
                societyMoney += this.bankService.getAccountMoney(acc);
            }

            let percentage = 0;
            const jobTaxTier = await this.configurationRepository.getValue('JobTaxTier');

            if (societyMoney <= jobTaxTier.Tier1) {
                percentage = jobTaxTier.Tier1Percentage / 100;
            } else if (societyMoney <= jobTaxTier.Tier2) {
                percentage = jobTaxTier.Tier2Percentage / 100;
            } else if (societyMoney <= jobTaxTier.Tier3) {
                percentage = jobTaxTier.Tier3Percentage / 100;
            } else if (societyMoney <= jobTaxTier.Tier4) {
                percentage = jobTaxTier.Tier4Percentage / 100;
            } else {
                percentage = jobTaxTier.Tier5Percentage / 100;
            }

            for (const acc of account) {
                const tax = Math.round(this.bankService.getAccountMoney(acc) * percentage);

                const result = await this.bankService.transferBankMoney(acc, 'gouv', tax);

                if (isErr(result)) {
                    this.logger.error(`Paiement impossible du gouvernement pour le compte ${acc}: ${result.err}`);
                } else {
                    this.logger.info(`Paiement du gouvernement pour le compte ${acc} de ${tax}`);
                }

                this.monitor.publish(
                    'gouv_tax',
                    {
                        source_account: acc,
                        target_account: 'gouv',
                    },
                    {
                        amount: tax,
                        percentage,
                    }
                );
            }
        }
    }
}
